"""One Python interpreter, and what it does with a cell.

These start real processes rather than standing one in, because everything
this file is about — a namespace that outlives a cell, a traceback that
names the researcher's own frame, a signal that ends a cell without ending
the kernel — is behaviour of an interpreter and not of the code around it.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from typing import Any

import pytest

from lykeion_kernel.confinement import confined
from lykeion_kernel.kernels import KernelIdentity
from lykeion_kernel.kernels import python as python_kernel
from lykeion_kernel.kernels.python import launch, start_token

identity = KernelIdentity(session_id="ses_1", task_id="tk_1", name="main", language="python")


def test_nothing_is_spawned_without_the_prefix_the_daemon_gave(monkeypatch):
    # The one property this file exists to hold: a kernel that cannot be
    # confined is not started, and there is no path that starts one anyway.
    calls = []
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **kw: calls.append(argv))
    with pytest.raises(ValueError, match="no confinement"):
        launch(identity, prefix=[])
    assert calls == []


def test_an_interpreter_runs_behind_what_the_daemon_handed_over():
    assert confined(["/x/confine", "-p", "(deny default)"], ["/y/python", "-u", "/z/driver.py"]) == [
        "/x/confine",
        "-p",
        "(deny default)",
        "/y/python",
        "-u",
        "/z/driver.py",
    ]


def test_a_kernel_records_the_pid_and_when_the_process_on_it_started(prefix):
    kernel = launch(identity, prefix)
    try:
        assert kernel.pid > 0
        assert kernel.start_token != ""
        assert kernel.start_token == start_token(kernel.pid)
        assert kernel.alive()
    finally:
        kernel.stop()


def test_a_kernel_that_has_ended_is_not_claimed_alive_on_its_pid_alone(prefix):
    kernel = launch(identity, prefix)
    recorded = kernel.start_token
    kernel.stop()

    assert not kernel.alive()
    # Whatever holds that pid next did not start when this kernel did, which
    # is the whole reason the token was recorded beside it.
    assert start_token(kernel.pid) != recorded


def test_a_kernel_is_not_alive_because_something_else_now_holds_its_pid(prefix, monkeypatch):
    # A pid coming round again cannot be arranged on demand, so what the
    # platform says about the process on one is what is changed here. The
    # kernel is untouched and still running; the token no longer matches.
    kernel = launch(identity, prefix)
    try:
        assert kernel.alive()
        monkeypatch.setattr(python_kernel, "start_token", lambda pid: "some later process")
        assert not kernel.alive()
    finally:
        kernel.stop()


def test_a_kernel_that_will_not_start_says_so_rather_than_being_waited_on(prefix, tmp_path):
    with pytest.raises(RuntimeError, match="did not start"):
        launch(identity, prefix, interpreter=str(tmp_path / "no-such-interpreter"))


def test_something_that_is_not_a_kernel_on_the_other_end_is_not_taken_for_one():
    # A prefix running a program of its own, which ignores what is
    # concatenated onto it. What answers is well-formed and is not a kernel,
    # so it is refused rather than left holding a pipe nothing will answer.
    speaking = [sys.executable, "-c", "print('{\"ready\": false}')"]
    with pytest.raises(RuntimeError, match="did not start"):
        launch(identity, speaking)


def test_a_process_on_the_machine_says_which_kernel_it_is(prefix):
    kernel = launch(identity, prefix)
    try:
        result = kernel.execute("import os\nprint(os.environ['LYKEION_KERNEL'])")
        assert stream_of(result, "stdout") == "ses_1/tk_1/main/python\n"
    finally:
        kernel.stop()


def test_a_bare_expression_comes_back_as_what_it_evaluated_to(prefix):
    kernel = launch(identity, prefix)
    try:
        result = kernel.execute("6 * 7")
        assert result["ok"] is True
        assert result["outputs"] == [
            {
                "kind": "execute_result",
                "execution_count": 1,
                "data": {"text/plain": "42"},
                "data_ref": {},
            }
        ]
    finally:
        kernel.stop()


def test_both_streams_come_back_in_the_order_they_were_written(prefix):
    kernel = launch(identity, prefix)
    try:
        result = kernel.execute(
            "import sys\n"
            "sys.stdout.write('one')\n"
            "sys.stdout.write('two')\n"
            "sys.stderr.write('bad')\n"
            "sys.stdout.write('three')\n"
        )
        assert result["outputs"] == [
            {"kind": "stream", "name": "stdout", "text": "onetwo"},
            {"kind": "stream", "name": "stderr", "text": "bad"},
            {"kind": "stream", "name": "stdout", "text": "three"},
        ]
    finally:
        kernel.stop()


def test_a_traceback_names_the_researchers_frame_and_not_the_one_that_ran_it(prefix):
    kernel = launch(identity, prefix)
    try:
        result = kernel.execute("def boom():\n    raise ValueError('no')\n\nboom()")
        error = result["outputs"][-1]
        assert result["ok"] is False
        assert error["kind"] == "error"
        assert error["ename"] == "ValueError"
        assert error["evalue"] == "no"
        assert any("boom" in line for line in error["traceback"])
        assert "driver.py" not in "\n".join(error["traceback"])
    finally:
        kernel.stop()


def test_a_value_this_kernel_cannot_display_does_not_end_it(prefix):
    kernel = launch(identity, prefix)
    try:
        kernel.execute("kept = 3")
        kernel.execute("class Unshowable:\n    def __repr__(self):\n        raise ValueError('no')")

        result = kernel.execute("Unshowable()")

        assert result["ok"] is True
        assert result["outputs"][-1]["data"]["text/plain"] == (
            "<a value this kernel could not render: ValueError>"
        )
        assert stream_of(kernel.execute("print(kept)"), "stdout") == "3\n"
    finally:
        kernel.stop()


def test_a_failure_this_kernel_cannot_describe_does_not_end_it_either(prefix):
    kernel = launch(identity, prefix)
    try:
        kernel.execute("kept = 4")
        kernel.execute(
            "class Unsayable(Exception):\n    def __str__(self):\n        raise ValueError('no')"
        )

        result = kernel.execute("raise Unsayable()")

        assert result["ok"] is False
        error = result["outputs"][-1]
        assert error["ename"] == "Unsayable"
        assert error["evalue"] == "<a Unsayable this kernel could not render: ValueError>"
        # The platform's own renderer says so in its own words rather than
        # raising, so the traceback survives and names the cell.
        assert error["traceback"][0] == "Traceback (most recent call last):"
        assert "Unsayable" in "\n".join(error["traceback"])
        assert stream_of(kernel.execute("print(kept)"), "stdout") == "4\n"
    finally:
        kernel.stop()


def test_what_a_value_prints_while_being_displayed_lands_in_the_cell(prefix):
    kernel = launch(identity, prefix)
    try:
        kernel.execute(
            "class Chatty:\n"
            "    def __repr__(self):\n"
            "        print('noise')\n"
            "        return 'shown'"
        )

        result = kernel.execute("Chatty()")

        # On the real stream that print would be a line the host tries to
        # read this cell's answer out of.
        assert result["outputs"] == [
            {"kind": "stream", "name": "stdout", "text": "noise\n"},
            {
                "kind": "execute_result",
                "execution_count": 2,
                "data": {"text/plain": "shown"},
                "data_ref": {},
            },
        ]
    finally:
        kernel.stop()


def test_a_failure_this_kernel_cannot_even_name_does_not_end_it(prefix):
    # The name of a class is an attribute of its metaclass, so a researcher
    # can write one that raises on being read. Reporting the failure is then
    # itself a failure, and the kernel has to come out of that holding what
    # it was holding before.
    kernel = launch(identity, prefix)
    try:
        kernel.execute("kept = 6")
        kernel.execute(
            "class Nameless(type):\n"
            "    @property\n"
            "    def __name__(cls):\n"
            "        raise ValueError('no')\n"
            "\n"
            "class Unnameable(Exception, metaclass=Nameless):\n"
            "    pass"
        )

        result = kernel.execute("raise Unnameable()")

        assert result["ok"] is False
        assert result["outputs"][-1]["ename"] == "<a failure this kernel could not render: ValueError>"
        assert stream_of(kernel.execute("print(kept)"), "stdout") == "6\n"
    finally:
        kernel.stop()


def test_a_failure_whose_own_naming_fails_the_same_way_does_not_end_it(prefix):
    # The placeholder a failed rendering falls back to asks for a name, and
    # asking for a name is the same metaclass property that just failed. A
    # class whose `__name__` raises an instance of itself makes the fallback
    # raise exactly what the handler was written to survive, and the kernel
    # would exit holding an afternoon's variables.
    kernel = launch(identity, prefix)
    try:
        kernel.execute("kept = 6")
        kernel.execute(
            "class Nameless(type):\n"
            "    @property\n"
            "    def __name__(cls):\n"
            "        raise Unnameable()\n"
            "\n"
            "class Unnameable(Exception, metaclass=Nameless):\n"
            "    pass"
        )

        result = kernel.execute("raise Unnameable()")

        assert result["ok"] is False
        assert result["outputs"][-1]["ename"] == (
            "<a failure this kernel could not render: something this kernel cannot name>"
        )
        assert stream_of(kernel.execute("print(kept)"), "stdout") == "6\n"
    finally:
        kernel.stop()


def test_a_cell_that_will_not_compile_is_reported_rather_than_fatal(prefix):
    kernel = launch(identity, prefix)
    try:
        result = kernel.execute("def (")
        assert result["ok"] is False
        assert result["outputs"][-1]["ename"] == "SyntaxError"
        # Nothing of this file's own is in a report about a cell that never ran.
        assert "driver.py" not in "\n".join(result["outputs"][-1]["traceback"])
        assert kernel.execute("1 + 1")["ok"] is True
    finally:
        kernel.stop()


def test_the_counter_rises_on_every_cell_including_the_ones_that_failed(prefix):
    kernel = launch(identity, prefix)
    try:
        assert kernel.execute("1")["execution_count"] == 1
        assert kernel.execute("nonexistent_name")["execution_count"] == 2
        assert kernel.execute("2")["execution_count"] == 3
    finally:
        kernel.stop()


def test_what_a_kernel_wrote_to_its_own_stderr_is_kept(prefix, until):
    kernel = launch(identity, prefix)
    try:
        kernel.execute("import os\nos.write(2, b'the boundary said no\\n')")
        until(lambda: "the boundary said no" in kernel.stderr_tail(), "the kernel's own stderr")
    finally:
        kernel.stop()


def test_a_signal_between_two_cells_does_not_take_the_namespace_with_it(prefix):
    # Every one of these lands on a kernel that is provably between cells:
    # the only thread that gives this kernel work is the one sending them.
    kernel = launch(identity, prefix)
    try:
        kernel.execute("kept = 2")
        for _ in range(200):
            os.kill(kernel.pid, signal.SIGINT)
        # Nothing is running, so there is nothing to observe arriving. This
        # waits out the delivery of signals that have already been sent.
        time.sleep(0.2)

        assert kernel.alive()
        assert stream_of(kernel.execute("print(kept)"), "stdout") == "2\n"
    finally:
        kernel.stop()


def test_a_signal_landing_anywhere_at_all_does_not_take_the_namespace_with_it(prefix):
    # The one above can only reach a kernel that is idle. This one reaches it
    # everywhere else too: reading a cell, running one, describing what one
    # did, writing the answer, and in every gap between those. Cells may fail
    # here — what is asserted is that each of them was answered at all, and
    # that the kernel came out the other side still holding what it was given.
    #
    # The rate is stated rather than maximised. Something asking for an
    # interrupt sends one per cell; this sends roughly two thousand a second
    # for the length of two hundred of them.
    kernel = launch(identity, prefix)
    hammering = threading.Event()

    def hammer() -> None:
        while not hammering.is_set():
            try:
                os.kill(kernel.pid, signal.SIGINT)
            except ProcessLookupError:
                return
            time.sleep(0.0005)

    try:
        kernel.execute("kept = 5")
        beating = threading.Thread(target=hammer)
        beating.start()
        try:
            for _ in range(200):
                assert "ok" in kernel.execute("1 + 1")
        finally:
            hammering.set()
            beating.join(timeout=10)

        assert kernel.alive()
        assert stream_of(kernel.execute("print(kept)"), "stdout") == "5\n"
    finally:
        hammering.set()
        kernel.stop()


def test_a_kernel_that_will_not_come_back_from_a_cell_is_ended_anyway(prefix, tmp_path, until):
    kernel = launch(identity, prefix)
    marker = tmp_path / "running"

    def hold() -> None:
        try:
            kernel.execute(
                f"import time\nopen({str(marker)!r}, 'w').close()\nwhile True:\n    time.sleep(0.05)"
            )
        except (RuntimeError, ValueError):
            # The kernel this cell was in is what the test is ending, and its
            # streams go with it.
            return

    inside = threading.Thread(target=hold)
    inside.start()
    try:
        until(marker.exists, "the cell to reach its loop")

        kernel.stop()

        assert not kernel.alive()
        with pytest.raises(ProcessLookupError):
            os.kill(kernel.pid, 0)
    finally:
        # Whatever the assertions did, the cell holding this thread only ends
        # when the process running it does.
        kernel.stop()
        inside.join(timeout=10)
    assert not inside.is_alive()


def test_a_kernel_killed_from_outside_stops_claiming_to_be_there(prefix, until):
    kernel = launch(identity, prefix)
    try:
        os.kill(kernel.pid, signal.SIGKILL)
        until(lambda: not kernel.alive(), "the killed kernel to be reported gone")
    finally:
        kernel.stop()


def test_a_kernel_runs_one_cell_at_a_time_in_the_order_they_arrived(prefix):
    # The kernel itself holds no queue — that is the registry's — so what is
    # asserted here is only that one process answers in the order it was
    # asked, which is what makes a queue in front of it worth having.
    kernel = launch(identity, prefix)
    try:
        assert kernel.execute("first = 1")["execution_count"] == 1
        assert kernel.execute("second = first + 1")["execution_count"] == 2
        assert stream_of(kernel.execute("print(second)"), "stdout") == "2\n"
    finally:
        kernel.stop()


def stream_of(result: dict[str, Any], name: str) -> str:
    return "".join(
        output["text"]
        for output in result["outputs"]
        if output["kind"] == "stream" and output["name"] == name
    )
