"""Which kernels a machine is holding, and which cell each runs next."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from typing import Any

import pytest

from lykeion_kernel.kernels import KernelIdentity
from lykeion_kernel.registry import Registry, kernel_id_for

ORIGIN = {"surface": "repl", "by": "u_1"}

# What a prefix leaves behind it that the kernel it started can be asked
# about. A real boundary is rendered by the daemon and describes something
# this process cannot express; what a test can assert about one either way is
# that the arguments in front of the interpreter were the ones it was handed.
BOUNDARY = "LYKEION_BOUNDARY"
READ_BOUNDARY = f"import os\nprint(os.environ[{BOUNDARY!r}])"


def identity_for(name: str, session_id: str = "ses_1") -> KernelIdentity:
    return KernelIdentity(session_id=session_id, task_id="tk_1", name=name, language="python")


def confine_session(
    holding: Registry,
    *,
    workspace: str,
    says: str,
    session_id: str = "ses_1",
    task_id: str = "tk_1",
    environment: str = "python",
) -> None:
    """Hands a session a prefix that runs what follows it and says so."""
    holding.configure_session(
        session_id=session_id,
        task_id=task_id,
        workspace=workspace,
        environment=environment,
        prefix=["/usr/bin/env", f"{BOUNDARY}={says}"],
    )


class _Session:
    """One session's kernels, each addressed by the context it belongs to."""

    def __init__(self, holding: Registry) -> None:
        self._registry = holding

    def execute(self, name: str, source: str) -> dict[str, Any]:
        return self._registry.execute(identity_for(name), source, origin=ORIGIN)

    def restart(self, name: str) -> dict[str, Any]:
        return self._registry.restart(kernel_id_for(identity_for(name)))

    def list(self) -> list[dict[str, Any]]:
        return self._registry.list()


@pytest.fixture
def host(registry: Registry) -> _Session:
    session = _Session(registry)
    # Every test below is about a kernel this session already holds, which is
    # what running a cell in one makes true.
    session.execute("k1", "pass")
    return session


def stdout_of(cell: dict[str, Any]) -> str:
    return "".join(
        output["text"]
        for output in cell["outputs"]
        if output["kind"] == "stream" and output["name"] == "stdout"
    )


def error_of(cell: dict[str, Any]) -> str:
    return "\n".join(
        "\n".join([output["ename"], output["evalue"], *output["traceback"]])
        for output in cell["outputs"]
        if output["kind"] == "error"
    )


def entry_of(holding: Registry, name: str, session_id: str = "ses_1") -> dict[str, Any]:
    wanted = kernel_id_for(identity_for(name, session_id))
    return next(entry for entry in holding.list() if entry["id"] == wanted)


def test_a_variable_set_in_one_cell_is_there_in_the_next(host):
    host.execute("k1", "x = 41")
    result = host.execute("k1", "print(x + 1)")
    assert result["ok"] is True
    assert "42" in stdout_of(result)


def test_a_restart_takes_the_namespace_with_it(host):
    host.execute("k1", "x = 1")
    host.restart("k1")
    result = host.execute("k1", "print(x)")
    assert result["ok"] is False
    assert "NameError" in error_of(result)


def test_a_restart_keeps_the_identity_and_raises_the_incarnation(host):
    before = host.list()[0]
    host.restart("k1")
    after = host.list()[0]
    assert after["id"] == before["id"]
    assert after["incarnation"] == before["incarnation"] + 1


def test_two_kernels_of_one_session_hold_separate_namespaces(host):
    host.execute("k1", "x = 1")
    result = host.execute("k2", "print('x' in dir())")
    assert "False" in stdout_of(result)


def test_a_failing_cell_reports_the_traceback_and_leaves_the_kernel_up(host):
    failed = host.execute("k1", "1 / 0")
    assert failed["ok"] is False
    assert "ZeroDivisionError" in error_of(failed)
    assert host.execute("k1", "print('still here')")["ok"] is True


def test_two_kernels_of_one_session_keep_their_own_counters(host):
    host.execute("k1", "1")
    assert host.execute("k2", "1")["executionCount"] == 1


def test_a_kernel_is_named_by_what_makes_it_that_kernel_and_nothing_else():
    assert kernel_id_for(identity_for("k1")) == kernel_id_for(identity_for("k1"))
    assert kernel_id_for(identity_for("k1")) != kernel_id_for(identity_for("k2"))
    assert kernel_id_for(identity_for("k1")) != kernel_id_for(identity_for("k1", "ses_2"))
    assert kernel_id_for(
        KernelIdentity(session_id="ses_1", task_id="tk_1", name="k1", language="r")
    ) != kernel_id_for(identity_for("k1"))


def test_a_kernel_keeps_its_name_across_the_processes_that_mint_it():
    # A kernel the lab saw yesterday has to be the same kernel today, so the
    # name cannot come from anything this particular process decided.
    minted = subprocess.run(
        [
            sys.executable,
            "-c",
            "from lykeion_kernel.kernels import KernelIdentity\n"
            "from lykeion_kernel.registry import kernel_id_for\n"
            "print(kernel_id_for(KernelIdentity('ses_1', 'tk_1', 'k1', 'python')))\n",
        ],
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "PYTHONHASHSEED": "1"},
    )
    assert minted.stdout.strip() == kernel_id_for(identity_for("k1"))


def test_a_kernel_nothing_could_start_is_known_and_holds_no_process():
    unconfined = Registry([])
    with pytest.raises(ValueError, match="no confinement"):
        unconfined.execute(identity_for("k1"), "x = 1", origin=ORIGIN)

    entry = unconfined.list()[0]
    assert entry["state"] == "lazy"
    assert entry["incarnation"] == 0
    assert entry["executionCount"] == 0
    assert entry["queueDepth"] == 0
    assert "startedTs" not in entry
    assert "lastActivityTs" not in entry


def test_a_kernel_nothing_could_start_cannot_be_restarted_into_existence():
    # A restart is what gives a kernel a fresh process, so it goes through
    # the same refusal a first cell does rather than around it.
    unconfined = Registry([])
    with pytest.raises(ValueError, match="no confinement"):
        unconfined.execute(identity_for("k1"), "x = 1", origin=ORIGIN)

    with pytest.raises(ValueError, match="no confinement"):
        unconfined.restart(kernel_id_for(identity_for("k1")))
    assert unconfined.list()[0]["incarnation"] == 0


def test_a_session_the_daemon_never_confined_cannot_launch_a_kernel(unconfined_registry, tmp_path):
    # One session's boundary is not another's: a host holding one is still a
    # host that starts nothing for a session it was never told about.
    confine_session(unconfined_registry, workspace=str(tmp_path), says="one-sessions-own")

    with pytest.raises(ValueError, match="no confinement"):
        unconfined_registry.execute(identity_for("k1", "ses_2"), "x = 1", origin=ORIGIN)


def test_a_configured_session_launches_its_kernels_behind_the_prefix_it_was_given(
    unconfined_registry, tmp_path
):
    confine_session(unconfined_registry, workspace=str(tmp_path), says="what-the-daemon-rendered")

    cell = unconfined_registry.execute(identity_for("k1"), READ_BOUNDARY, origin=ORIGIN)

    assert cell["ok"] is True
    # The prefix ran, rather than merely being recorded: this is the kernel
    # saying what the arguments in front of it put in its own environment.
    assert "what-the-daemon-rendered" in stdout_of(cell)


def test_reconfiguring_a_session_replaces_the_boundary_its_next_kernel_gets(
    unconfined_registry, tmp_path
):
    confine_session(unconfined_registry, workspace=str(tmp_path), says="first")
    unconfined_registry.execute(identity_for("k1"), "1", origin=ORIGIN)

    confine_session(unconfined_registry, workspace=str(tmp_path), says="second")
    unconfined_registry.restart(kernel_id_for(identity_for("k1")))

    cell = unconfined_registry.execute(identity_for("k1"), READ_BOUNDARY, origin=ORIGIN)
    assert "second" in stdout_of(cell)


def test_a_kernel_starts_in_the_workspace_its_session_was_confined_for(
    unconfined_registry, tmp_path
):
    # The one directory the boundary lets it write, which is where a cell
    # opening a file by name has to land.
    confine_session(unconfined_registry, workspace=str(tmp_path), says="anything")

    cell = unconfined_registry.execute(
        identity_for("k1"), "import os\nprint(os.getcwd())", origin=ORIGIN
    )

    assert stdout_of(cell).strip() == os.path.realpath(tmp_path)


def test_a_cell_carries_the_environment_its_session_was_confined_for(unconfined_registry, tmp_path):
    confine_session(
        unconfined_registry, workspace=str(tmp_path), environment="python-3.13", says="anything"
    )

    cell = unconfined_registry.execute(identity_for("k1"), "1", origin=ORIGIN)

    assert cell["environment"] == "python-3.13"
    assert entry_of(unconfined_registry, "k1")["environment"] == "python-3.13"


def test_a_cell_names_the_environment_its_own_process_is_in(unconfined_registry, tmp_path):
    # A running kernel keeps the boundary it was started inside, so a session
    # configured again decides what the next process gets and moves nothing
    # that is already running. A cell reporting the newer environment would be
    # a result attributed to somewhere it was not computed.
    confine_session(
        unconfined_registry, workspace=str(tmp_path), environment="python-3.12", says="anything"
    )
    unconfined_registry.execute(identity_for("k1"), "1", origin=ORIGIN)

    confine_session(
        unconfined_registry, workspace=str(tmp_path), environment="python-3.13", says="anything"
    )
    standing = unconfined_registry.execute(identity_for("k1"), "1", origin=ORIGIN)

    assert standing["environment"] == "python-3.12"
    assert entry_of(unconfined_registry, "k1")["environment"] == "python-3.12"

    # And a restart is how a researcher asks to leave it.
    unconfined_registry.restart(kernel_id_for(identity_for("k1")))
    replaced = unconfined_registry.execute(identity_for("k1"), "1", origin=ORIGIN)

    assert replaced["environment"] == "python-3.13"
    assert entry_of(unconfined_registry, "k1")["environment"] == "python-3.13"


def test_a_kernel_of_another_task_is_not_started_inside_this_ones_boundary(
    unconfined_registry, tmp_path
):
    # A boundary is drawn around one Task's directory. Starting another Task's
    # kernel inside it would hand that Task's work the first one's workspace.
    confine_session(unconfined_registry, workspace=str(tmp_path), task_id="tk_1", says="anything")
    elsewhere = KernelIdentity(session_id="ses_1", task_id="tk_2", name="k1", language="python")

    with pytest.raises(ValueError, match="tk_2"):
        unconfined_registry.execute(elsewhere, "x = 1", origin=ORIGIN)


def test_releasing_a_session_forgets_the_boundary_it_was_given(unconfined_registry, tmp_path):
    confine_session(unconfined_registry, workspace=str(tmp_path), says="anything")
    unconfined_registry.execute(identity_for("k1"), "1", origin=ORIGIN)

    unconfined_registry.release_session("ses_1")

    with pytest.raises(ValueError, match="no confinement"):
        unconfined_registry.execute(identity_for("k1"), "1", origin=ORIGIN)


def test_a_cell_carries_everything_the_lab_records_of_it(registry):
    cell = registry.execute(identity_for("k1"), "print('hi')", origin=ORIGIN)

    assert cell["kernelId"] == kernel_id_for(identity_for("k1"))
    assert cell["name"] == "k1"
    assert cell["language"] == "python"
    assert cell["environment"] == "python"
    assert cell["executionCount"] == 1
    assert cell["source"] == "print('hi')"
    assert cell["origin"] == {"surface": "repl", "by": "u_1"}
    assert cell["ok"] is True
    assert cell["outputs"] == [{"kind": "stream", "name": "stdout", "text": "hi\n"}]
    assert isinstance(cell["wallMs"], int) and cell["wallMs"] >= 0
    assert isinstance(cell["ts"], int)
    # Absent, not null: a cell the researcher typed is not a tool call.
    assert "toolUseId" not in cell


def test_a_cell_an_agent_ran_says_which_tool_call_it_arrived_as(registry):
    cell = registry.execute(
        identity_for("k1"),
        "1",
        origin={"surface": "agent", "by": "claude"},
        tool_use_id="tu_9",
    )
    assert cell["origin"] == {"surface": "agent", "by": "claude"}
    assert cell["toolUseId"] == "tu_9"


def test_a_cell_is_announced_to_whatever_is_listening(registry):
    announced: list[dict[str, Any]] = []
    registry.on_cell = announced.append

    cell = registry.execute(identity_for("k1"), "1", origin=ORIGIN)

    assert announced == [cell]


def test_a_kernel_reports_what_it_is_and_how_far_it_has_got(registry):
    registry.execute(identity_for("k1"), "1", origin=ORIGIN)
    entry = entry_of(registry, "k1")

    assert entry["sessionId"] == "ses_1"
    assert entry["taskId"] == "tk_1"
    assert entry["name"] == "k1"
    assert entry["language"] == "python"
    assert entry["environment"] == "python"
    assert entry["state"] == "idle"
    assert entry["incarnation"] == 1
    assert entry["executionCount"] == 1
    assert entry["queueDepth"] == 0
    assert isinstance(entry["startedTs"], int)
    assert isinstance(entry["lastActivityTs"], int)


def test_a_kernel_that_died_is_reported_crashed_rather_than_stopped(registry):
    registry.execute(identity_for("k1"), "1", origin=ORIGIN)

    with pytest.raises(RuntimeError, match="stopped while running"):
        registry.execute(
            identity_for("k1"),
            "import os, signal\nos.kill(os.getpid(), signal.SIGKILL)",
            origin=ORIGIN,
        )

    assert entry_of(registry, "k1")["state"] == "crashed"


def test_a_crashed_kernel_is_not_quietly_replaced_under_the_next_cell(registry):
    registry.execute(identity_for("k1"), "kept = 1", origin=ORIGIN)
    with pytest.raises(RuntimeError):
        registry.execute(
            identity_for("k1"),
            "import os, signal\nos.kill(os.getpid(), signal.SIGKILL)",
            origin=ORIGIN,
        )

    with pytest.raises(RuntimeError, match="crashed"):
        registry.execute(identity_for("k1"), "print(kept)", origin=ORIGIN)

    # A restart is how a researcher asks for a new one, and it works.
    registry.restart(kernel_id_for(identity_for("k1")))
    assert registry.execute(identity_for("k1"), "print('back')", origin=ORIGIN)["ok"] is True


def test_a_restart_starts_the_counter_over(registry):
    registry.execute(identity_for("k1"), "1", origin=ORIGIN)
    registry.execute(identity_for("k1"), "2", origin=ORIGIN)
    registry.restart(kernel_id_for(identity_for("k1")))

    assert registry.execute(identity_for("k1"), "3", origin=ORIGIN)["executionCount"] == 1


def test_a_restart_answers_with_the_kernel_it_left_behind(registry):
    registry.execute(identity_for("k1"), "1", origin=ORIGIN)
    restarted = registry.restart(kernel_id_for(identity_for("k1")))

    assert restarted["incarnation"] == 2
    assert restarted["executionCount"] == 0
    assert restarted["state"] == "idle"


def test_a_kernel_this_machine_does_not_hold_cannot_be_restarted_or_interrupted(registry):
    with pytest.raises(ValueError, match="no kernel"):
        registry.restart("k_nothing")
    with pytest.raises(ValueError, match="no kernel"):
        registry.interrupt("k_nothing")


def test_a_cell_that_arrives_while_one_is_running_waits_behind_it(registry, tmp_path, until):
    gate = tmp_path / "gate"
    os.mkfifo(gate)
    first: dict[str, Any] = {}
    second: dict[str, Any] = {}

    held = threading.Thread(
        target=lambda: first.update(
            registry.execute(identity_for("k1"), f"open({str(gate)!r}).read()", origin=ORIGIN)
        )
    )
    held.start()
    until(lambda: entry_of(registry, "k1")["state"] == "running", "the first cell to start")

    waiting = threading.Thread(
        target=lambda: second.update(
            registry.execute(identity_for("k1"), "print('second')", origin=ORIGIN)
        )
    )
    waiting.start()
    until(lambda: entry_of(registry, "k1")["queueDepth"] == 1, "the second cell to queue")

    # A kernel of the same session is not behind that queue.
    assert registry.execute(identity_for("k2"), "print('other')", origin=ORIGIN)["ok"] is True
    assert entry_of(registry, "k1")["queueDepth"] == 1

    with open(gate, "w") as opening:
        opening.write("go")
    held.join(timeout=10)
    waiting.join(timeout=10)

    assert not held.is_alive() and not waiting.is_alive()
    assert first["executionCount"] == 1
    assert second["executionCount"] == 2
    assert entry_of(registry, "k1")["queueDepth"] == 0


def test_an_interrupt_ends_the_cell_that_is_running_and_leaves_the_kernel_up(
    registry, tmp_path, until
):
    marker = tmp_path / "running"
    held: dict[str, Any] = {}
    running = threading.Thread(
        target=lambda: held.update(
            registry.execute(
                identity_for("k1"),
                f"import time\nopen({str(marker)!r}, 'w').close()\nwhile True:\n    time.sleep(0.05)",
                origin=ORIGIN,
            )
        )
    )
    running.start()
    until(marker.exists, "the cell to reach its loop")

    registry.interrupt(kernel_id_for(identity_for("k1")))
    running.join(timeout=10)

    assert not running.is_alive()
    assert held["ok"] is False
    assert "KeyboardInterrupt" in error_of(held)
    assert registry.execute(identity_for("k1"), "print('after')", origin=ORIGIN)["ok"] is True


def test_releasing_a_session_ends_its_kernels_and_forgets_them(registry, tmp_path):
    told = tmp_path / "pid"
    registry.execute(
        identity_for("k1"),
        f"import os\nopen({str(told)!r}, 'w').write(str(os.getpid()))",
        origin=ORIGIN,
    )
    registry.execute(identity_for("k1", "ses_2"), "1", origin=ORIGIN)
    pid = int(told.read_text())

    assert registry.release_session("ses_1") == 1

    assert [entry["sessionId"] for entry in registry.list()] == ["ses_2"]
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_a_host_that_is_stopping_leaves_no_kernel_running(registry, tmp_path):
    told = tmp_path / "pid"
    registry.execute(
        identity_for("k1"),
        f"import os\nopen({str(told)!r}, 'w').write(str(os.getpid()))",
        origin=ORIGIN,
    )
    pid = int(told.read_text())

    registry.shutdown()

    assert registry.list()[0]["state"] == "stopped"
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
