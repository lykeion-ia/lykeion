import io
import json

from lykeion_kernel.host import serve
from lykeion_kernel.registry import Registry

CELL = {
    "session_id": "ses_1",
    "task_id": "tk_1",
    "name": "main",
    "language": "python",
    "origin": {"surface": "agent", "by": "claude"},
}


def request(method: str, params: dict, request_id: int | None = None) -> io.StringIO:
    message = {"method": method, "params": params}
    if request_id is not None:
        message = {"id": request_id, **message}
    return io.StringIO(json.dumps(message) + "\n")


def replies(stdout: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stdout.getvalue().splitlines()]


def test_answers_hello_with_what_it_is():
    stdin = io.StringIO('{"id": 1, "method": "host.hello", "params": {}}\n')
    stdout = io.StringIO()

    serve(stdin, stdout)

    line = stdout.getvalue().strip()
    assert '"id": 1' in line
    assert '"protocol": 1' in line


def test_an_unknown_method_is_answered_rather_than_ignored():
    stdin = io.StringIO('{"id": 7, "method": "host.nonsense", "params": {}}\n')
    stdout = io.StringIO()

    serve(stdin, stdout)

    assert '"id": 7' in stdout.getvalue()
    assert "host.nonsense" in stdout.getvalue()


def test_a_call_whose_params_are_not_an_object_is_answered_and_the_host_goes_on(spoken, tmp_path):
    # A message this host cannot read a single field out of. What it must not
    # be is the end of the process: every session's kernels on this machine
    # are behind this one loop, and one message nobody can read is a poor
    # reason to end all of them.
    spoken.send(
        {
            "id": 1,
            "method": "kernel.configure_session",
            "params": {
                "session_id": "ses_1",
                "task_id": "tk_1",
                "workspace": str(tmp_path),
                "environment": "python",
                "prefix": ["/usr/bin/env"],
            },
        }
    )
    spoken.until(lambda: spoken.reply(1), "the session confined")

    for asked, params in enumerate(["oops", [1, 2, 3], 5, True], start=2):
        spoken.send({"id": asked, "method": "kernel.execute", "params": params})
        refused = spoken.until(lambda: spoken.reply(asked), f"the call carrying {params!r}")
        # Named for what is wrong with it, rather than answered with whatever
        # the first field this host reached for happened to raise.
        assert refused["error"]["message"] == "a call's params are an object"

    spoken.send({"id": 9, "method": "kernel.execute", "params": {**CELL, "source": "6 * 7"}})
    ran = spoken.until(lambda: spoken.reply(9), "the host still answering afterwards")

    assert ran["result"]["ok"] is True


def test_a_notification_is_not_answered():
    # No id is what makes a message a notification. Answering one puts an
    # object on the stream the daemon has nothing to match it against.
    stdin = io.StringIO('{"method": "host.hello", "params": {}}\n')
    stdout = io.StringIO()

    serve(stdin, stdout)

    assert stdout.getvalue() == ""


def test_a_notification_naming_an_unknown_method_is_not_answered_either():
    stdin = io.StringIO('{"method": "host.nonsense", "params": {}}\n')
    stdout = io.StringIO()

    serve(stdin, stdout)

    assert stdout.getvalue() == ""


def test_a_handler_that_raises_is_answered_with_what_went_wrong():
    stdout = io.StringIO()

    serve(request("kernel.execute", {**CELL, "language": "r", "source": "1"}, 9), stdout)

    reply = replies(stdout)[0]
    assert reply["id"] == 9
    assert "holds no r kernels" in reply["error"]["message"]


def test_a_cell_missing_what_the_lab_records_of_it_is_refused():
    for params, expected in [
        ({**CELL}, "a cell has a source"),
        ({**CELL, "source": 7}, "a cell has a source"),
        ({**{k: v for k, v in CELL.items() if k != "origin"}, "source": "1"}, "where it came from"),
        ({**CELL, "source": "1", "origin": {"surface": "cron", "by": "u_1"}}, "not from cron"),
        ({**CELL, "source": "1", "origin": {"surface": "repl"}}, "who ran it"),
        ({**{k: v for k, v in CELL.items() if k != "task_id"}, "source": "1"}, "needs a task_id"),
    ]:
        stdout = io.StringIO()
        serve(request("kernel.execute", params, 1), stdout)
        assert expected in replies(stdout)[0]["error"]["message"]


def test_a_kernel_this_host_does_not_hold_is_named_back_rather_than_invented():
    for method in ("kernel.restart", "kernel.interrupt"):
        stdout = io.StringIO()
        serve(request(method, {"kernel_id": "k_nothing"}, 1), stdout)
        assert "k_nothing" in replies(stdout)[0]["error"]["message"]


def test_a_notification_whose_handler_raises_is_still_not_answered():
    stdout = io.StringIO()

    serve(request("kernel.execute", {**CELL, "language": "r", "source": "1"}), stdout)

    assert stdout.getvalue() == ""


def test_a_kernel_the_daemon_never_confined_is_refused_rather_than_spawned():
    # The host answering this has no prefix, because nothing has given it
    # one. What it must not do is start an interpreter anyway.
    stdout = io.StringIO()

    serve(request("kernel.execute", {**CELL, "source": "1"}, 3), stdout)

    assert "no confinement" in replies(stdout)[0]["error"]["message"]


def test_a_session_the_daemon_confines_gets_its_boundary_and_starts_kernels_in_it(spoken, tmp_path):
    # The whole arrangement over the wire: the daemon says what it rendered,
    # waits to be told that landed, and the kernel that starts afterwards is
    # running behind it. Waited for rather than sent together, because a host
    # reads the next message while this one is still being answered.
    spoken.send(
        {
            "id": 1,
            "method": "kernel.configure_session",
            "params": {
                "session_id": "ses_1",
                "task_id": "tk_1",
                "workspace": str(tmp_path),
                "environment": "python",
                "prefix": ["/usr/bin/env", "LYKEION_BOUNDARY=what-the-daemon-rendered"],
            },
        }
    )
    assert spoken.until(lambda: spoken.reply(1), "the session confined") == {
        "id": 1,
        "result": {},
    }

    spoken.send(
        {
            "id": 2,
            "method": "kernel.execute",
            "params": {**CELL, "source": "import os\nprint(os.environ['LYKEION_BOUNDARY'])"},
        }
    )
    ran = spoken.until(lambda: spoken.reply(2), "the cell that ran inside it")

    assert ran["result"]["outputs"] == [
        {"kind": "stream", "name": "stdout", "text": "what-the-daemon-rendered\n"}
    ]


def test_a_confinement_missing_what_it_is_made_of_is_refused():
    whole = {
        "session_id": "ses_1",
        "task_id": "tk_1",
        "workspace": "/w",
        "environment": "python",
        "prefix": [],
    }
    for missing in ("session_id", "task_id", "workspace", "environment"):
        stdout = io.StringIO()
        params = {key: value for key, value in whole.items() if key != missing}
        serve(request("kernel.configure_session", params, 1), stdout)
        assert f"needs a {missing}" in replies(stdout)[0]["error"]["message"]

    # A boundary is an argument list, and anything else is not one this host
    # could concatenate an interpreter onto.
    for prefix in ("--", [7], None):
        stdout = io.StringIO()
        serve(request("kernel.configure_session", {**whole, "prefix": prefix}, 1), stdout)
        assert "list of arguments" in replies(stdout)[0]["error"]["message"]


def test_the_host_says_which_kernels_it_is_holding():
    stdout = io.StringIO()

    serve(request("kernel.list", {}, 2), stdout)

    assert replies(stdout)[0] == {"id": 2, "result": {"kernels": []}}


def test_a_session_this_host_never_held_is_released_without_complaint():
    stdout = io.StringIO()

    serve(request("kernel.release_session", {"session_id": "ses_1"}, 5), stdout)

    assert replies(stdout)[0] == {"id": 5, "result": {"released": 0}}


def test_a_cell_reaches_the_lab_as_well_as_whoever_asked_for_it(prefix):
    stdout = io.StringIO()
    stdin = request("kernel.execute", {**CELL, "source": "print(6 * 7)", "tool_use_id": "tu_1"}, 4)

    serve(stdin, stdout, Registry(prefix))

    announced, reply = replies(stdout)
    assert announced["method"] == "cell"
    assert reply["id"] == 4
    # One event seen twice: what the caller awaited and what reaches the lab
    # are the same cell rather than two renderings of it.
    assert announced["params"] == reply["result"]
    assert reply["result"]["toolUseId"] == "tu_1"
    assert reply["result"]["outputs"] == [{"kind": "stream", "name": "stdout", "text": "42\n"}]


def test_a_cell_names_the_session_and_task_that_ran_it(prefix):
    # Nothing on the wire otherwise says which session or Task a "cell"
    # notification belongs to — `kernelId` is a digest, not an address — so
    # whoever routes the notification back to a run needs these two named
    # directly rather than inverting the digest.
    stdout = io.StringIO()
    stdin = request("kernel.execute", {**CELL, "source": "1"}, 9)

    serve(stdin, stdout, Registry(prefix))

    announced, _reply = replies(stdout)
    assert announced["params"]["sessionId"] == "ses_1"
    assert announced["params"]["taskId"] == "tk_1"


def test_a_kernel_this_host_holds_is_ended_when_its_own_stdin_does(prefix):
    stdout = io.StringIO()
    stdin = request("kernel.execute", {**CELL, "source": "1"}, 6)
    holding = Registry(prefix)

    serve(stdin, stdout, holding)

    assert holding.list()[0]["state"] == "stopped"
