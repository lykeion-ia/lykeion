import io
import json
from pathlib import Path
import os
import sys
import threading
import time
from typing import Any, IO

import pytest

from lykeion_kernel.host import Holding, _arriving, _execute, serve
from lykeion_kernel.kernels import KernelIdentity
from lykeion_kernel.mcp.endpoint import Endpoints
from lykeion_kernel.provenance.store import ProvenanceStore
from lykeion_kernel.registry import Registry

CELL = {
    "session_id": "ses_1",
    "task_id": "tk_1",
    "name": "main",
    "language": "python",
    "origin": {"surface": "agent", "by": "claude"},
}


def python_environment(*, says: str | None = None) -> list[dict]:
    """One Python environment, the shape `kernel.configure_session` takes on
    the wire, optionally running a boundary that says something on start."""
    prefix = ["/usr/bin/env"] if says is None else ["/usr/bin/env", f"LYKEION_BOUNDARY={says}"]
    return [
        {
            "language": "python",
            "name": "python",
            "interpreter": sys.executable,
            "prefix": prefix,
            "default": True,
        }
    ]


def request(method: str, params: dict, request_id: int | None = None) -> io.StringIO:
    message = {"method": method, "params": params}
    if request_id is not None:
        message = {"id": request_id, **message}
    return io.StringIO(json.dumps(message) + "\n")


def _identity(session_id: str, task_id: str) -> KernelIdentity:
    """One session's main Python kernel, addressed directly rather than
    through a confinement — what a host told nothing about a session falls
    back to."""
    return KernelIdentity(
        session_id=session_id, task_id=task_id, name="main",
        language="python", environment="python",
    )


def replies(stdout: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stdout.getvalue().splitlines()]


def test_answers_hello_with_what_it_is():
    stdin = io.StringIO('{"id": 1, "method": "host.hello", "params": {}}\n')
    stdout = io.StringIO()

    serve(stdin, stdout)

    line = stdout.getvalue().strip()
    assert '"id": 1' in line
    assert '"protocol": 5' in line


def test_the_greeting_says_where_this_machines_records_belong(tmp_path):
    # A host left to choose for itself writes under a home directory — the
    # same pile for every daemon on this machine, whatever each was told to
    # keep its own state in. Only the daemon knows which directory is its own,
    # so it says so on the greeting, before any session exists.
    store = ProvenanceStore(tmp_path / "unchosen")
    registry = Registry([], store=store)

    serve(
        request("host.hello", {"storeRoot": str(tmp_path / "chosen")}, request_id=1),
        io.StringIO(),
        registry,
    )

    digest = store.put_envelope({"version": "lykeion.provenance.v1"})
    assert (tmp_path / "chosen" / "envelopes" / digest[:2] / digest).exists()
    assert not (tmp_path / "unchosen").exists()


def test_a_greeting_that_names_nowhere_leaves_the_records_where_they_were(tmp_path):
    # Silence is not an instruction to move. A caller that built this registry
    # with a store of its own already said where these belong.
    store = ProvenanceStore(tmp_path / "given")
    registry = Registry([], store=store)

    serve(request("host.hello", {}, request_id=1), io.StringIO(), registry)

    assert store.root == tmp_path / "given"


def test_a_code_state_reaches_the_session_the_call_names(prefix, tmp_path):
    """The wire call carries a session, and the record follows it.

    One host holds every session on this machine. A call that named none, or
    a handler that dropped the name it was given, would put whichever Task
    spoke last onto the record of every cell running anywhere on the
    machine — and those records are immutable and named by the hash of their
    own bytes, so nothing downstream could ever tell.
    """
    said = {
        "status": "available",
        "value": {"repository": "/w", "branch": "trunk", "commit": "c" * 40, "dirty": False},
    }
    registry = Registry(prefix, store=ProvenanceStore(tmp_path / "records"))
    origin = {"surface": "agent", "by": "claude"}
    try:
        serve(
            request("kernel.set_code_state", {"session_id": "ses_told", "codeState": said}),
            io.StringIO(),
            registry,
        )
        told = registry.execute(_identity("ses_told", "tk_1"), "x = 1", origin=origin)
        silent = registry.execute(_identity("ses_silent", "tk_2"), "x = 1", origin=origin)
    finally:
        registry.shutdown()

    assert told["provenance"]["input"]["codeState"]["git"] == said
    assert silent["provenance"]["input"]["codeState"]["git"] == {
        "status": "unavailable",
        "reason": "not_captured",
    }


def test_a_code_state_naming_no_session_is_refused():
    # Filing it under a stand-in session would be this host deciding which
    # Task a repository belongs to, which is a thing only the daemon knows.
    stdout = io.StringIO()

    serve(
        request(
            "kernel.set_code_state",
            {"codeState": {"status": "unavailable", "reason": "not_applicable"}},
            request_id=11,
        ),
        stdout,
        Registry([]),
    )

    answered = json.loads(stdout.getvalue().strip())
    assert answered["id"] == 11
    assert "session_id" in answered["error"]["message"]


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
                "environments": python_environment(),
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

    # A language nothing here has a launcher for. R is never this any more —
    # `LAUNCHERS` holds it unconditionally regardless of the machine, since
    # Task 6 — so `julia`, which no LAUNCHERS row will ever name, is what
    # still proves a handler asked for a language that runs raises nothing.
    serve(request("kernel.execute", {**CELL, "language": "julia", "source": "1"}, 9), stdout)

    reply = replies(stdout)[0]
    assert reply["id"] == 9
    assert "holds no julia kernels" in reply["error"]["message"]


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


def test_restarting_an_environment_needs_no_session_and_names_no_kernel():
    """What has changed is a DIRECTORY on this machine.

    Every session with a kernel in that environment is affected, not only the
    one whose agent asked for the packages — and the daemon reaching this has
    a rebuild it has just carried out, not a session. A method that required
    one here would leave a colleague's kernel running against an interpreter
    `uv venv --clear` has already deleted.

    A host holding nothing answers with an empty list rather than refusing:
    the first build of an environment nothing is bound to is the ordinary
    case, and a refusal would turn every one of them into a reported failure.
    """
    stdout = io.StringIO()

    serve(request("kernel.restart_environment", {"name": "crispr", "reason": "scanpy was added"}, 5), stdout)

    reply = replies(stdout)[0]
    assert reply["id"] == 5
    assert reply["result"] == {"restarted": []}


def test_restarting_an_environment_with_no_name_is_refused():
    # The one field this cannot do without: a rebuild is about one
    # environment, and a call that named none could only mean all of them.
    stdout = io.StringIO()

    serve(request("kernel.restart_environment", {"reason": "scanpy was added"}, 6), stdout)

    assert "needs a name" in replies(stdout)[0]["error"]["message"]


def test_a_notification_whose_handler_raises_is_still_not_answered():
    stdout = io.StringIO()

    serve(request("kernel.execute", {**CELL, "language": "julia", "source": "1"}), stdout)

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
                "environments": python_environment(says="what-the-daemon-rendered"),
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


def test_a_cell_naming_a_second_environment_over_the_wire_runs_in_it(spoken, tmp_path):
    spoken.send(
        {
            "id": 1,
            "method": "kernel.configure_session",
            "params": {
                "session_id": "ses_1",
                "task_id": "tk_1",
                "workspace": str(tmp_path),
                "environments": [
                    {
                        "language": "python", "name": "python",
                        "interpreter": sys.executable, "prefix": ["/usr/bin/env"], "default": True,
                    },
                    {
                        "language": "python", "name": "crispr",
                        "interpreter": sys.executable, "prefix": ["/usr/bin/env"],
                    },
                ],
            },
        }
    )
    spoken.until(lambda: spoken.reply(1), "the session confined")

    spoken.send(
        {
            "id": 2,
            "method": "kernel.execute",
            "params": {**CELL, "source": "1", "environment": "crispr"},
        }
    )
    ran = spoken.until(lambda: spoken.reply(2), "the cell run in the environment it named")

    assert ran["result"]["environment"] == "crispr"


def test_a_cell_runs_against_the_identity_its_place_was_taken_for(tmp_path):
    """`_arriving` resolves a cell's identity once, on the reading thread,
    and takes its place in that kernel's queue; `_execute` runs the cell
    later, on a worker thread of its own. `identity_for` reads live session
    state, so if `_execute` resolved its own identity instead of using the
    one its place already carries, a session reconfigured in between could
    have it running a different kernel than the one that queued for it — a
    place taken in kernel A's turn, evaluated against kernel B's, which has
    no correct outcome (`Turn.taken` reads `self._waiting[0]` on a queue
    that place was never added to; on an empty one, `IndexError`).

    Forced deterministically rather than raced: `_arriving` and `_execute`
    are the same two functions `serve()`'s reading loop and its worker
    thread call, called here directly, in the same order and with the same
    reconfiguration landing between them that a real race would need luck
    to produce — this is not a test that could pass by chance where a real
    race would sometimes lose. `python` stays declared across the
    reconfiguration, so a bug that re-resolved would not be masked by the
    environment it moved to having simply vanished from the session — it
    would instead run in the wrong kernel and be caught by the assertion,
    or crash outright as described above.
    """
    registry = Registry([])
    holding = Holding(registry=registry, endpoints=Endpoints(registry))
    try:
        registry.configure_session(
            session_id="ses_1",
            task_id="tk_1",
            workspace=str(tmp_path),
            environments=[
                {
                    "language": "python", "name": "python",
                    "interpreter": sys.executable, "prefix": ["/usr/bin/env"], "default": True,
                },
            ],
        )
        params = {**CELL, "source": "1"}

        place = _arriving(holding, "kernel.execute", params)
        assert place is not None

        registry.configure_session(
            session_id="ses_1",
            task_id="tk_1",
            workspace=str(tmp_path),
            environments=[
                {
                    "language": "python", "name": "python",
                    "interpreter": sys.executable, "prefix": ["/usr/bin/env"],
                },
                {
                    "language": "python", "name": "crispr",
                    "interpreter": sys.executable, "prefix": ["/usr/bin/env"], "default": True,
                },
            ],
        )

        cell = _execute(holding, params, place)

        assert cell["ok"] is True
        assert cell["environment"] == "python"
    finally:
        registry.shutdown()


def test_a_confinement_missing_what_it_is_made_of_is_refused():
    whole = {
        "session_id": "ses_1",
        "task_id": "tk_1",
        "workspace": "/w",
        "environments": python_environment(),
    }
    for missing in ("session_id", "task_id", "workspace"):
        stdout = io.StringIO()
        params = {key: value for key, value in whole.items() if key != missing}
        serve(request("kernel.configure_session", params, 1), stdout)
        assert f"needs a {missing}" in replies(stdout)[0]["error"]["message"]

    # A confinement is a list of environments, and anything this process
    # cannot concatenate an interpreter onto is not one of them.
    malformed = [
        "--",
        None,
        [7],
        [{"language": "python", "interpreter": sys.executable, "prefix": ["/usr/bin/env"]}],
        [{"language": "python", "name": "python", "interpreter": 7, "prefix": ["/usr/bin/env"]}],
        [{"language": "python", "name": "python", "interpreter": sys.executable, "prefix": "not-a-list"}],
        [{"language": "python", "name": "python", "interpreter": sys.executable, "prefix": [7]}],
    ]
    for environments in malformed:
        stdout = io.StringIO()
        serve(
            request("kernel.configure_session", {**whole, "environments": environments}, 1),
            stdout,
        )
        assert "a confinement is a list of environments" in replies(stdout)[0]["error"]["message"]


def test_the_declaration_list_arrives_from_the_wire_or_is_left_absent():
    """The key the daemon leaves off when the lab would not answer.

    Absent and empty are two different messages here, and the host has to
    keep them apart all the way from the wire: a session told nothing about
    what this lab declares must not be configured as one told the lab
    declares nothing, because the refusals downstream read the two
    differently.
    """
    whole = {
        "session_id": "ses_1",
        "task_id": "tk_1",
        "workspace": "/w",
        "environments": python_environment(),
    }

    said = Registry([])
    serve(request("kernel.configure_session", {**whole, "declared": ["python", "crispr"]}, 1), io.StringIO(), said)
    assert said.confinement_for("ses_1").declared == frozenset({"python", "crispr"})

    declared_none = Registry([])
    serve(request("kernel.configure_session", {**whole, "declared": []}, 1), io.StringIO(), declared_none)
    assert declared_none.confinement_for("ses_1").declared == frozenset()

    never_asked = Registry([])
    serve(request("kernel.configure_session", whole, 1), io.StringIO(), never_asked)
    assert never_asked.confinement_for("ses_1").declared is None

    stdout = io.StringIO()
    serve(request("kernel.configure_session", {**whole, "declared": [{"name": "crispr"}]}, 1), stdout)
    assert "a declaration list is a list of names" in replies(stdout)[0]["error"]["message"]


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


def _reading() -> tuple[IO[str], IO[str]]:
    """A real pipe, so a test can end this host's stdin the way the daemon
    does — by closing the far end — rather than by handing `serve` a stream
    that was already finished before it started."""
    read_fd, write_fd = os.pipe()
    return os.fdopen(read_fd, "r"), os.fdopen(write_fd, "w", buffering=1)


def _until(check, what: str, seconds: float = 5.0) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.01)
    raise AssertionError(f"{what} never happened")


def test_a_reply_from_the_daemon_reaches_the_thread_that_asked():
    """The second direction, read the way the daemon writes it.

    An ask carries this host's own id and the daemon answers under it. The
    reply carries an id and no method, so a loop that read it as a request
    would answer it with `no method named None` and leave the thread that
    asked blocked on something nobody is going to send.
    """
    stdin, daemon = _reading()
    stdout = io.StringIO()
    kernels = Registry([])
    serving = threading.Thread(target=serve, args=(stdin, stdout, kernels), daemon=True)
    serving.start()
    try:
        _until(lambda: kernels.ask_daemon is not None, "the asking side being wired")
        answered: list[Any] = []
        asking = threading.Thread(
            target=lambda: answered.append(
                kernels.ask_daemon("environment.create", {"name": "crispr"})
            ),
            daemon=True,
        )
        asking.start()
        _until(lambda: '"environment.create"' in stdout.getvalue(), "the ask being written")
        ask = json.loads(stdout.getvalue().splitlines()[-1])
        assert ask["params"] == {"name": "crispr"}
        # Numbered from this host's own counter, which starts at 1 and knows
        # nothing about how many requests the daemon has sent.
        assert ask["id"] == 1

        daemon.write(json.dumps({"id": ask["id"], "result": {"name": "crispr"}}) + "\n")
        asking.join(timeout=5)
        assert not asking.is_alive()
        assert answered == [{"name": "crispr"}]
        # Answered, and not also mistaken for a call: nothing was written
        # back about a method nobody named.
        assert "no method named" not in stdout.getvalue()
    finally:
        daemon.close()
        serving.join(timeout=5)


def test_an_ask_waiting_on_a_reply_is_settled_when_the_stream_ends():
    """A daemon that closed this host's stdin is never going to answer.

    Settled where the stream ends rather than left blocked: the thread
    waiting is inside a tool call somebody is watching, and a promise nothing
    settles is indistinguishable from a machine that stopped answering. It is
    also what keeps that thread from sitting out the whole draining deadline
    for a reply that cannot arrive.
    """
    stdin, daemon = _reading()
    stdout = io.StringIO()
    kernels = Registry([])
    serving = threading.Thread(target=serve, args=(stdin, stdout, kernels), daemon=True)
    serving.start()
    _until(lambda: kernels.ask_daemon is not None, "the asking side being wired")
    outcome: list[Any] = []
    def waiting() -> None:
        try:
            outcome.append(kernels.ask_daemon("environment.create", {"name": "crispr"}))
        except ValueError as failure:
            outcome.append(failure)
    asking = threading.Thread(target=waiting, daemon=True)
    asking.start()
    _until(lambda: '"environment.create"' in stdout.getvalue(), "the ask being written")

    daemon.close()

    asking.join(timeout=2)
    assert not asking.is_alive()
    assert isinstance(outcome[0], ValueError)
    assert "no longer answering" in str(outcome[0])
    serving.join(timeout=5)
    assert not serving.is_alive()


def test_an_ask_made_after_the_stream_ended_is_refused_rather_than_blocked():
    """The same fact, asked later. A tool call that reaches for the daemon
    after it has gone is owed the refusal the blocked one got, not a wait
    that nothing can end."""
    stdin, daemon = _reading()
    stdout = io.StringIO()
    kernels = Registry([])
    serving = threading.Thread(target=serve, args=(stdin, stdout, kernels), daemon=True)
    serving.start()
    _until(lambda: kernels.ask_daemon is not None, "the asking side being wired")
    ask = kernels.ask_daemon
    daemon.close()
    serving.join(timeout=5)

    with pytest.raises(ValueError, match="no longer answering"):
        ask("environment.create", {"name": "crispr"})


def test_hello_says_what_an_environment_of_each_language_must_read():
    """The reads a kernel needs that its environment root does not contain.

    A kernel is started as `<interpreter> <driver>`, and the driver is a file
    in THIS package — not in the environment the interpreter came from. The
    boundary is `(deny default)`, so that file has to be granted or the
    process dies before its first instruction, with nothing on stderr to say
    why.

    Python got this for free: its floor descriptor lists the driver's own
    directory among its reads, and a built `python` environment inherits the
    floor's reads for its language. R has no floor descriptor at all — it is
    deliberately no longer discovered from a bare `Rscript` — so a built R
    environment's read set was its root and nothing else, and every R kernel
    on a real machine failed to start.

    Reported per language this host can LAUNCH rather than per language it
    discovered, because that is the question being answered: what would an
    environment of this language need, if one existed.
    """
    stdin = io.StringIO('{"id": 1, "method": "host.hello", "params": {}}\n')
    stdout = io.StringIO()
    serve(stdin, stdout)
    said = json.loads(stdout.getvalue().strip())["result"]

    assert set(said["environmentReads"]) == set(said["capable"])
    for language, reads in said["environmentReads"].items():
        assert reads, f"{language} claims to be launchable and names nothing to read"
        for path in reads:
            assert Path(path).is_dir(), f"{language} names {path}, which is not a directory"


def test_the_research_default_arrives_from_the_wire_or_is_left_empty():
    """Which environment an unaddressed cell of each language lands in, as
    the Research itself decided rather than as this machine happened to
    build.

    Separate from the entries on purpose: a Research can name a default this
    machine has not built, and a map folded into the entry list would lose
    exactly that case — the one where a researcher most needs to be told the
    environment by name.
    """
    whole = {
        "session_id": "ses_1",
        "task_id": "tk_1",
        "workspace": "/w",
        "environments": python_environment(),
    }

    said = Registry([])
    serve(
        request(
            "kernel.configure_session",
            {**whole, "defaults": {"r": "meta-analysis-r"}},
            1,
        ),
        io.StringIO(),
        said,
    )
    assert said.confinement_for("ses_1").defaults == {"r": "meta-analysis-r"}

    # No Research default is an empty map, not a missing one: the fallback to
    # this machine's own floor is what answers then, and it is read the same
    # way whether the daemon said nothing or said nothing was set.
    unsaid = Registry([])
    serve(request("kernel.configure_session", whole, 1), io.StringIO(), unsaid)
    assert unsaid.confinement_for("ses_1").defaults == {}
    assert unsaid.confinement_for("ses_1").default_for("python") == "python"

    stdout = io.StringIO()
    serve(
        request("kernel.configure_session", {**whole, "defaults": {"r": 7}}, 1),
        stdout,
    )
    assert (
        "a confinement's defaults are one environment name per language"
        in replies(stdout)[0]["error"]["message"]
    )
