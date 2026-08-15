"""Which kernels a machine is holding, and which cell each runs next."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from typing import Any

import pytest

import lykeion_kernel.registry as registry_module
from lykeion_kernel.kernels import KernelIdentity
from lykeion_kernel.kernels.python import launch as launch_python
from lykeion_kernel.registry import RING, Registry, kernel_id_for

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
        prefixes={"python": ["/usr/bin/env", f"{BOUNDARY}={says}"]},
        environments={"python": environment},
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


def in_a_cell(host: _Session, source: str) -> tuple[threading.Thread, dict[str, Any]]:
    """Runs a cell on `k1` in the background and hands back where its result
    will land. The kernel is holding a cell by the time this returns."""
    landed: dict[str, Any] = {}
    running = threading.Event()

    def run() -> None:
        running.set()
        try:
            landed["cell"] = host.execute("k1", source)
        except BaseException as err:  # noqa: BLE001
            landed["raised"] = err

    worker = threading.Thread(target=run)
    worker.start()
    running.wait()
    # The flag says the thread reached `execute`, not that the interpreter is
    # inside the cell — the same gap `kernel.interrupt` documents at
    # `registry.py:339`. A moment here is what makes the difference.
    time.sleep(0.5)
    return worker, landed


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


def test_a_listed_kernel_carries_its_process_and_what_it_is_using(host, registry):
    """The figures reach the report the lab reads, or the screen goes on
    rendering an em dash for a kernel that is right there."""
    registry.sample()
    described = entry_of(registry, "k1")
    assert described["processId"] > 0
    assert described["resources"]["memoryBytes"] > 0


def test_a_kernel_nobody_has_measured_reports_no_resources_key(host, registry):
    """Absent, not zero — asserted on the key's presence, because that is what
    the wire carries and what the formatter branches on. A kernel nobody has
    sampled has no reading; one measured at nothing would have `0`."""
    described = entry_of(registry, "k1")
    assert "resources" not in described


def test_the_series_holds_the_readings_taken_so_far(host, registry):
    for _ in range(3):
        registry.sample()
    assert len(entry_of(registry, "k1")["series"]) == 3


def test_the_series_never_grows_past_its_bound(host, registry):
    for _ in range(RING + 5):
        registry.sample()
    assert len(entry_of(registry, "k1")["series"]) == RING


def test_a_restart_clears_the_series(host, registry):
    """A sparkline spanning two processes describes neither."""
    for _ in range(3):
        registry.sample()
    host.restart("k1")
    assert "series" not in entry_of(registry, "k1")


class _ReadingThatLetsTheSamplerIn:
    """A reading whose first field access hands the ring to a sampler tick.

    `_described` reads each reading's fields as it builds the series, so a
    hook here parks the answer exactly between two of the ring's own
    `__next__` calls — which is where a real sampler's append lands, and the
    one place a deque being walked in place raises rather than being read
    stale. Standing in for a `Sample` rather than subclassing one, because a
    frozen dataclass has no room for a field that does something when read.
    """

    cpu_percent = None

    def __init__(self, hand_over: Any) -> None:
        self._hand_over = hand_over

    @property
    def memory_bytes(self) -> int:
        self._hand_over()
        return 1


def test_a_sampler_tick_landing_mid_answer_does_not_cost_a_machine_its_kernels(
    host, registry
):
    """`sample()` appends to a kernel's ring on every tick, and `list()`
    walks that same ring to build the series. Walked in place, an append
    between two readings raises `RuntimeError: deque mutated during
    iteration` — which reaches the daemon as an error answer, has it post no
    kernels at all, and leaves a machine that is online and running work
    reporting that it holds none for the whole of that poll.

    Nothing here is left to timing: the first reading in the ring parks this
    answer on an `Event` the moment its field is read, a real `sample()` runs
    to completion on another thread while it sits there, and only then is the
    answer released to reach the second reading. Copied out under the lock
    before anything is built, that append lands on a deque this answer is no
    longer walking; walked in place, it lands on the one it is.
    """
    entry = registry._entries[kernel_id_for(identity_for("k1"))]  # noqa: SLF001
    let_the_sampler_in = threading.Event()
    sampler_done = threading.Event()

    def hand_over() -> None:
        let_the_sampler_in.set()
        assert sampler_done.wait(timeout=10), "the sampler tick never finished"

    entry.ring.clear()
    entry.ring.append(_ReadingThatLetsTheSamplerIn(hand_over))
    # A second reading, because the mutation is only felt by the `__next__`
    # that comes after it.
    entry.ring.append(_ReadingThatLetsTheSamplerIn(lambda: None))

    def tick() -> None:
        assert let_the_sampler_in.wait(timeout=10), "the answer never reached the ring"
        registry.sample()
        sampler_done.set()

    sampling = threading.Thread(target=tick)
    sampling.start()
    try:
        described = entry_of(registry, "k1")
    finally:
        sampling.join(timeout=10)
    assert not sampling.is_alive()
    # Answered from the two readings the ring held when the answer began. The
    # tick's own reading belongs to the next poll, not to a series built
    # before it existed.
    assert described["series"] == [{"memoryBytes": 1}, {"memoryBytes": 1}]


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


def test_a_stopped_cell_comes_back_carrying_what_the_researcher_said(host, registry):
    """The agent reads the reason as the result of the call it was in."""
    worker, landed = in_a_cell(host, "import time; time.sleep(30)")
    registry.stop(
        kernel_id_for(identity_for("k1")),
        feedback="redo this using less memory",
        by="m_12",
    )
    worker.join(timeout=10)

    cell = landed["cell"]
    assert cell["ok"] is False
    assert "KernelStopped" in error_of(cell)
    assert "redo this using less memory" in error_of(cell)
    assert "m_12" in error_of(cell)
    # The counter the kernel had actually reached — the fixture ran one cell
    # in it — and not a literal zero, which would report a kernel that had run
    # cells as one that had run none, in the very record saying a person
    # ended it.
    assert cell["executionCount"] == 1


def test_a_kernel_stopped_with_nothing_said_is_still_a_stop(host, registry):
    """What separates a stop from a crash is that somebody chose it, not that
    they had something to say about it.

    A researcher who ends a running kernel without typing a reason has still
    ended it, and reporting that to the agent as a crash would be the record
    saying something false about who did what.
    """
    worker, landed = in_a_cell(host, "import time; time.sleep(30)")
    registry.stop(kernel_id_for(identity_for("k1")), by="m_12")
    worker.join(timeout=10)

    cell = landed["cell"]
    assert cell["ok"] is False
    assert "KernelStopped" in error_of(cell)
    assert "m_12" in error_of(cell)
    assert entry_of(registry, "k1")["state"] == "stopped"


def test_a_kernel_that_dies_on_its_own_is_a_crash_and_not_a_stop(host, registry):
    """The same abandonment on the pipe, two records. Nobody chose this one,
    and a crash reported as a stop would invent a person who did."""
    worker, landed = in_a_cell(host, "import os; os.kill(os.getpid(), 9)")
    worker.join(timeout=10)
    assert isinstance(landed["raised"], RuntimeError)
    assert entry_of(registry, "k1")["state"] == "crashed"


def test_stopping_an_idle_kernel_succeeds_and_drops_the_message(host, registry):
    """There was never a call for the feedback to land on. Not an error: the
    control only offers the field while something is running, but the screen's
    state is a poll old and the host cannot rely on that."""
    registry.stop(kernel_id_for(identity_for("k1")), feedback="never delivered", by="m_12")
    described = entry_of(registry, "k1")
    assert described["state"] == "stopped"
    assert described["stoppedBy"] == "m_12"
    # Dropped means no cell was ever handed it, not that the host forgot who
    # said what: the entry goes on reporting both for as long as it stays
    # ended.
    assert described["stopReason"] == "never delivered"


def test_a_cell_that_finishes_first_leaves_the_stop_nothing_to_attach_to(host, registry):
    """A researcher clicks Stop, and the cell completes before the command
    lands. The kernel still stops; the message is dropped; nothing raises."""
    host.execute("k1", "x = 1")
    registry.stop(kernel_id_for(identity_for("k1")), feedback="too late", by="m_12")
    assert entry_of(registry, "k1")["state"] == "stopped"
    # And the reason must not be left waiting to be attached to a later cell.
    host.execute("k1", "y = 2")
    assert entry_of(registry, "k1")["state"] in ("idle", "running")


def test_a_reason_given_to_one_process_never_lands_on_the_nexts_crash(host, registry):
    """The harm a reason left standing does, which no state alone shows.

    A stop is announced about one process. The process that replaces it
    falling over is nobody's doing, and a reason still waiting on the entry
    would turn that crash into a stop by somebody who ended something that no
    longer exists.
    """
    registry.stop(kernel_id_for(identity_for("k1")), feedback="too much memory", by="m_12")
    host.execute("k1", "x = 1")

    with pytest.raises(RuntimeError, match="stopped while running"):
        host.execute("k1", "import os; os.kill(os.getpid(), 9)")
    assert entry_of(registry, "k1")["state"] == "crashed"
    assert "stoppedBy" not in entry_of(registry, "k1")


def test_a_cell_queued_behind_a_stopped_kernel_runs_in_the_fresh_namespace_today(
    host, registry
):
    """Pins what happens today — not what should happen.

    A cell already queued behind a kernel when it is stopped is not told the
    kernel it was queued for is gone. By the time its turn comes, `stop()`
    has already dropped the handle (`entry.kernel = None`), so `_running`
    finds a lazy entry and relaunches through `_replace` exactly as it would
    for any other cold start — the queued cell runs in the new, empty
    namespace and can succeed there with a plausible wrong answer, which is
    worse than raising would be: nothing about the result says it was
    computed against a namespace its author never saw.

    The reviewer's ruling, accepted, is that this is wrong in principle —
    whoever wrote the queued cell did not know the namespace would go — but
    the correct fix is not a one-liner. It needs a `stopped` flag threaded
    onto `Place` and set across `Turn._waiting`, and checking
    `stop_requested` inside `execute` the way the crash/stop discriminator
    does would also break the legitimate relaunch the *next* cell after a
    stop is owed. So it is deferred to its own task, and this test exists so
    that fix changes the assertion below on purpose, not by accident.

    Queued with `arriving()` rather than a second live thread: that is what a
    stream reader actually calls the moment a second cell arrives, before the
    first has finished, and it removes any dependence on how long `stop()`'s
    own kill takes relative to a thread racing to read `entry.kernel` — a
    second, unrelated race this test is not the one pinning.
    """
    worker, landed = in_a_cell(host, "import time; time.sleep(30)")
    queued_place = registry.arriving(identity_for("k1"))

    registry.stop(kernel_id_for(identity_for("k1")), feedback="too much memory", by="m_12")
    worker.join(timeout=10)

    assert landed["cell"]["ok"] is False  # the stop, as the tests above cover

    queued = registry.execute(
        identity_for("k1"), "1 + 1", origin=ORIGIN, place=queued_place
    )
    # Today's gap: the queued cell was never told its kernel went. It ran in
    # a fresh process instead, and succeeded.
    assert queued["ok"] is True
    assert entry_of(registry, "k1")["state"] in ("idle", "running")


def test_stops_flag_writes_and_a_lazy_relaunchs_clearing_of_them_do_not_interleave(
    registry, monkeypatch
):
    """`stop()` writes `stopped`, `stop_requested`, `stop_reason`, and
    `stopped_by`; a lazy relaunch through `_replace` clears the same four.
    Both now write under `self._lock` — this pins that they share the one
    mutex rather than each taking a lock of their own (or none), which is
    the difference between a torn write reaching `execute`'s discriminator —
    a relaunch reading `stop_requested` mid-way through `stop()`'s four
    assignments, or `stop()` writing over a relaunch's half-finished clear —
    and one that cannot happen.

    Forced rather than raced, so this does not join the flaky first draft of
    the queued-cell test above: the relaunch's own kernel launch is wrapped
    so it parks on an `Event` right after spawning the real process and
    before returning it to `_replace`, which is well past `_replace`'s own,
    separate, pre-existing lock use inside `_confinement_for` and well
    before the flag-clearing block this fix put under `self._lock`. With
    the relaunch parked there, this thread takes `self._lock` itself — free
    to take, since the relaunch is waiting on the `Event`, not on the lock —
    releases the relaunch, and keeps holding the lock across a bounded join.

    Locked correctly, the relaunch cannot reach its own clearing without
    this lock: it is still alive and `stop()`'s exact values are still on
    the entry at the end of that join, not because the join happened to end
    before the relaunch got there but because nothing let it past the lock
    this thread is holding. Unlocked, the clearing runs the instant the
    `Event` fires, regardless of anything this thread does with the lock
    afterward — the four fields would already read cleared by the time this
    checks them, and the relaunch thread would already be finished, well
    inside the join's one-second budget for four attribute writes.
    """
    kernel_id = kernel_id_for(identity_for("k1"))
    registry.execute(identity_for("k1"), "pass", origin=ORIGIN)
    registry.stop(kernel_id, feedback="too slow", by="m_1")
    entry = registry._entries[kernel_id]
    assert (entry.stopped, entry.stop_requested, entry.stop_reason, entry.stopped_by) == (
        True,
        True,
        "too slow",
        "m_1",
    )

    spawned = threading.Event()
    may_finish = threading.Event()

    def paused_launch(identity, prefix, interpreter, workspace):
        kernel = launch_python(identity, prefix, interpreter, workspace)
        spawned.set()
        may_finish.wait(timeout=10)
        return kernel

    monkeypatch.setitem(registry_module.LAUNCHERS, "python", paused_launch)

    relaunching = threading.Thread(
        target=lambda: registry.execute(identity_for("k1"), "1 + 1", origin=ORIGIN)
    )
    relaunching.start()
    assert spawned.wait(timeout=10), "the relaunch never reached its own launcher"

    with registry._lock:
        may_finish.set()
        relaunching.join(timeout=1.0)
        assert relaunching.is_alive(), "the relaunch finished without ever needing this lock"
        assert (entry.stopped, entry.stop_requested, entry.stop_reason, entry.stopped_by) == (
            True,
            True,
            "too slow",
            "m_1",
        )

    relaunching.join(timeout=10)
    assert not relaunching.is_alive()
    assert (entry.stopped, entry.stop_requested, entry.stop_reason, entry.stopped_by) == (
        False,
        False,
        None,
        None,
    )


def test_stops_post_kill_write_of_stopped_also_takes_the_lock(registry, monkeypatch):
    """`stop()` writes `stop_requested`, `stop_reason`, and `stopped_by`
    under `self._lock` before the kill, and `stopped` after it — and
    `_replace`'s clearing block writes all four of the same names under that
    lock too. This pins that the fourth write shares the mutex the other
    three already do, rather than landing free of it: `_replace` sets
    `entry.stopped = False` as one of its own four assignments inside
    `self._lock`, and a `stopped` write with no lock of its own could still
    land between that block's individual assignments — after `stopped` is
    cleared but before the other three are — leaving `stopped` true while
    the rest read cleared, which is a state `_state()` and `list()` would
    both show.

    Forced the same way the sibling test above forces it, in the opposite
    direction: this time it is the kernel's own `stop()` that is wrapped to
    park on an `Event`, right after being called and before returning —
    which is well past `stop()`'s own first, locked, three-field write, and
    is where the real escalation ladder would still be running. With the
    kill parked there, this thread takes `self._lock` itself — free to
    take, since the parked thread is waiting on the `Event`, not on the
    lock — releases the kill, and keeps holding the lock across a bounded
    join.

    Locked correctly, `stop()` cannot reach its own write of `stopped`
    without this lock: the kill has already returned and the only thing
    left standing between it and that assignment is the lock this thread is
    holding, so the thread is still alive at the end of the bounded join and
    `entry.stopped` still reads `False`, not because the join happened to
    end before the write landed but because nothing let it past the lock.
    Unlocked, the write runs the instant the kill returns regardless of
    anything this thread does with the lock afterward — `entry.stopped`
    would already read `True` and the thread would already be finished, well
    inside the join's one-second budget for one attribute write following a
    kill of an idle process that exits the moment its stdin closes.
    """
    kernel_id = kernel_id_for(identity_for("k1"))
    registry.execute(identity_for("k1"), "pass", origin=ORIGIN)
    entry = registry._entries[kernel_id]
    live_kernel = entry.kernel
    assert live_kernel is not None

    reached_kill = threading.Event()
    may_finish_kill = threading.Event()
    real_stop = live_kernel.stop

    def paused_stop() -> None:
        reached_kill.set()
        may_finish_kill.wait(timeout=10)
        real_stop()

    monkeypatch.setattr(live_kernel, "stop", paused_stop)

    stopping = threading.Thread(
        target=lambda: registry.stop(kernel_id, feedback="too slow", by="m_1")
    )
    stopping.start()
    assert reached_kill.wait(timeout=10), "stop() never reached the kill"
    # Past `stop()`'s first, locked write — the handle is already dropped —
    # and parked before the kill it is about to call; `stopped` is the one
    # field that write never touched.
    assert entry.kernel is None
    assert entry.stopped is False

    with registry._lock:
        may_finish_kill.set()
        stopping.join(timeout=1.0)
        assert stopping.is_alive(), "stop() finished without ever needing this lock"
        assert entry.stopped is False

    stopping.join(timeout=10)
    assert not stopping.is_alive()
    assert entry.stopped is True


def test_a_relaunch_that_wins_the_race_is_left_alone_by_a_paused_stop(
    host, registry, monkeypatch
):
    """Between `stop()` dropping the handle and its post-kill writes, the
    kernel's own escalation ladder holds that window open — a second per rung,
    and its drain `join` does not return early while the cell's forked workers
    still hold the pipe, which is the workload somebody reaches for Stop over.
    The in-flight cell raises the moment the process dies and a queued one
    relaunches this same entry through `_replace` inside that second. Without
    a latch, `stop()`'s post-kill block lands on that relaunch anyway: a
    kernel with a live process reports `stopped` — permanently, since
    `stopped` is the first branch `_state` asks and `_replace` only runs for an
    entry holding no kernel — and the probe, reading, and ring it was just
    given are all thrown away, so the sampler and the pressure policy never
    see it again. A later crash of that live process would then be reported as
    the ending somebody chose, which is the one distinction this whole feature
    exists to keep.

    Forced exactly the way the reclaim sibling below forces its own race, and
    with nothing left to timing: the kernel `stop()` is about to kill is
    wrapped so it parks on an `Event` right after being called and before
    returning — well past `stop()`'s own first, locked write (the handle is
    already dropped and `stop_requested` is already set), and exactly where
    the real ladder would still be running. With the kill parked there the
    relaunch below runs to completion, synchronously, on this thread, with
    nothing else able to touch the entry; the parked thread cannot reach its
    post-kill block until `may_finish_kill` is set, and that happens only
    after the relaunch has finished and this thread has read what it left.
    """
    kernel_id = kernel_id_for(identity_for("k1"))
    entry = registry._entries[kernel_id]  # noqa: SLF001
    old_kernel = entry.kernel
    assert old_kernel is not None

    reached_kill = threading.Event()
    may_finish_kill = threading.Event()
    real_stop = old_kernel.stop

    def paused_stop() -> None:
        reached_kill.set()
        may_finish_kill.wait(timeout=10)
        real_stop()

    monkeypatch.setattr(old_kernel, "stop", paused_stop)

    stopping = threading.Thread(
        target=lambda: registry.stop(kernel_id, feedback="too slow", by="m_1")
    )
    stopping.start()
    assert reached_kill.wait(timeout=10), "stop() never reached the kill"
    # Past stop()'s first locked block: the handle is already dropped and the
    # latch its post-kill block will read is already set.
    assert entry.kernel is None
    assert entry.stop_requested is True

    # The relaunch that wins the race, run to completion on this thread while
    # the kill sits parked on the `Event` above and can observe none of it.
    result = host.execute("k1", "print('back')")
    assert result["ok"] is True
    assert entry.stop_requested is False  # `_replace` already cleared it
    # A reading of the live process, so the ring and the newest sample are
    # holding something a stale write would visibly throw away.
    registry.sample()
    live_probe = entry.probe
    assert live_probe is not None
    live_latest = entry.latest
    assert len(entry.ring) == 1
    incarnation_after_relaunch = entry.incarnation

    may_finish_kill.set()
    stopping.join(timeout=10)
    assert not stopping.is_alive()

    # `stop()` still ran the kill it started against the old process — that
    # part already happened and cannot be undone — but the entry it would have
    # written an ending over now holds a different, live incarnation, and the
    # fix is that it leaves that incarnation entirely alone: not one of the
    # five writes, since a half-applied ending is still an ending reported
    # over a kernel that has not had one.
    assert entry.stopped is False
    assert entry.probe is live_probe
    assert entry.latest is live_latest
    assert len(entry.ring) == 1
    assert entry.incarnation == incarnation_after_relaunch
    assert state_of(registry, kernel_id) == "idle"


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


def test_a_language_this_machine_cannot_run_is_refused_before_a_kernel_is_minted(registry):
    # Named as a language nothing here has a launcher for, which is what this
    # is about. R was the stand-in until this machine grew one, and a test that
    # kept it would be asserting the refusal against a language that runs.
    identity = KernelIdentity(session_id="ses_1", task_id="task_1", name="main", language="julia")
    with pytest.raises(ValueError, match="no julia kernels"):
        registry.arriving(identity)
    # Refused where the entry would have been minted. An entry with no
    # launcher behind it is a kernel `listRunningKernels` reports to the whole
    # lab and no cell can ever run in.
    assert registry.list() == []


def test_it_is_refused_where_a_cell_runs_as_well_as_where_it_arrived(registry):
    identity = KernelIdentity(session_id="ses_1", task_id="task_1", name="main", language="julia")
    with pytest.raises(ValueError, match="no julia kernels"):
        registry.execute(identity, "1", origin={"surface": "agent", "by": "claude"})
    assert registry.list() == []


def test_python_is_launched_through_the_table_and_still_runs(registry):
    identity = KernelIdentity(session_id="ses_1", task_id="task_1", name="main", language="python")
    cell = registry.execute(identity, "1 + 1", origin={"surface": "agent", "by": "claude"})
    assert cell["ok"] is True
    assert cell["language"] == "python"


def test_a_cell_records_the_environment_its_own_language_was_confined_for(registry):
    registry.configure_session(
        session_id="ses_1",
        task_id="task_1",
        workspace=None,
        prefixes={"python": ["/usr/bin/env"]},
        environments={"python": "python-3.12"},
    )
    identity = KernelIdentity(session_id="ses_1", task_id="task_1", name="main", language="python")
    cell = registry.execute(identity, "1", origin={"surface": "agent", "by": "claude"})
    assert cell["environment"] == "python-3.12"


GB = 1024 * 1024 * 1024


def idled(holding: Registry, name: str, *, seconds: int) -> str:
    """Backdates a kernel's last activity and returns its id.

    Reaching into the entry rather than waiting: the alternative is a suite
    that takes forty minutes to assert a forty-minute idle. Idleness is the
    only input the policy reads, so this is the whole of the setup.
    """
    kernel_id = kernel_id_for(identity_for(name))
    with holding._lock:  # noqa: SLF001
        holding._entries[kernel_id].last_activity_ts = int(time.time()) - seconds  # noqa: SLF001
    return kernel_id


def state_of(holding: Registry, kernel_id: str) -> str:
    return next(entry["state"] for entry in holding.list() if entry["id"] == kernel_id)


def test_nothing_is_reclaimed_below_the_ceiling(host, registry):
    """The test that says D7 was implemented and not quietly turned back into
    a timer: an idle kernel on a roomy machine survives any amount of
    thinking. If this ever fails, the policy has become a clock."""
    k = idled(registry, "k1", seconds=9 * 3600)
    registry.reclaim(total_memory=8 * GB, holding=1 * GB)
    assert state_of(registry, k) == "idle"


def test_over_the_ceiling_the_least_recently_used_goes(host, registry):
    host.execute("k2", "pass")
    old = idled(registry, "k1", seconds=40 * 60)
    recent = idled(registry, "k2", seconds=6 * 60)
    registry.reclaim(total_memory=8 * GB, holding=7 * GB)
    assert state_of(registry, old) == "reclaimed"
    assert state_of(registry, recent) == "idle"


def test_a_running_kernel_is_never_reclaimed(host, registry):
    """Killing live work to save memory is the one thing Stop exists to make
    deliberate. The policy must not reintroduce it through a side door."""
    worker, _ = in_a_cell(host, "import time; time.sleep(30)")
    k = idled(registry, "k1", seconds=40 * 60)
    registry.reclaim(total_memory=8 * GB, holding=8 * GB)
    assert state_of(registry, k) == "running"
    registry.stop(k)
    worker.join(timeout=10)


def test_a_kernel_idle_less_than_the_floor_survives_pressure(host, registry):
    k = idled(registry, "k1", seconds=2 * 60)
    registry.reclaim(total_memory=8 * GB, holding=8 * GB)
    assert state_of(registry, k) == "idle"


def test_only_one_goes_per_pass(host, registry):
    """Resident memory does not return the instant a process dies, so a batch
    chosen from one reading takes three kernels to get under a line that one
    would have cleared."""
    for name, minutes in (("k2", 30), ("k3", 20)):
        host.execute(name, "pass")
        idled(registry, name, seconds=minutes * 60)
    idled(registry, "k1", seconds=40 * 60)
    registry.reclaim(total_memory=8 * GB, holding=8 * GB)
    assert sum(1 for entry in registry.list() if entry["state"] == "reclaimed") == 1


def test_reclaiming_leaves_a_stopped_kernel_untouched(host, registry):
    """A kernel somebody ended holds the sentence they typed, forever. The
    two endings stay distinguishable, which is why the reason is recorded."""
    k = idled(registry, "k1", seconds=40 * 60)
    registry.stop(k, feedback="mine", by="m_12")
    registry.reclaim(total_memory=8 * GB, holding=8 * GB)
    assert state_of(registry, k) == "stopped"
    assert entry_of(registry, "k1")["stoppedBy"] == "m_12"


def test_a_reclaimed_kernel_comes_back_empty_at_the_next_incarnation(host, registry):
    host.execute("k1", "kept = 1")
    before = entry_of(registry, "k1")["incarnation"]
    k = idled(registry, "k1", seconds=40 * 60)
    registry.reclaim(total_memory=8 * GB, holding=8 * GB)
    result = host.execute("k1", "print('kept' in dir())")
    assert entry_of(registry, "k1")["incarnation"] == before + 1
    assert "False" in stdout_of(result)
    # The relaunch is a fresh process, not one still wearing the ending of
    # the one it replaced: `_replace` clears `reclaimed_ts` in the same
    # locked block it clears `stopped`/`stop_requested` in, and a kernel
    # left reporting `reclaimed` after a cell just ran in it would contradict
    # the field's own contract — "gone again the moment a fresh process
    # comes up."
    assert state_of(registry, k) == "idle"


def test_a_relaunch_that_wins_the_race_is_left_alone_by_a_paused_reclaim(
    host, registry, monkeypatch
):
    """Between `reclaim()` dropping the handle and its post-kill stamp,
    `kernel.stop()`'s escalation ladder can hold that window open for
    seconds, unlocked — long enough for a cell to arrive and relaunch this
    same entry through `_replace` before `reclaim()`'s own post-kill block
    ever runs. Without `reclaim_requested`, that block would land anyway: a
    kernel `_replace` just gave a live process would be stamped
    `reclaimed_ts` and have the very probe reading it was just given nulled
    out from under it — permanently mislabelled, and invisible to the
    sampler that would otherwise have gone on reading it.

    Forced the same way `test_stops_post_kill_write_of_stopped_also_takes_the_lock`
    forces its own race: the kernel `reclaim()` is about to kill is wrapped
    so it parks on an `Event` right after being called and before returning
    — well past `reclaim()`'s own first, locked write (the handle is already
    dropped and `reclaim_requested` is already set), and exactly where the
    real escalation ladder would still be running. With the kill parked
    there, the relaunch below runs to completion — synchronously, on this
    thread, with nothing else able to touch the entry — before the kill is
    ever allowed to return. There is no timing left to chance: the paused
    thread cannot reach its own post-kill block until `may_finish_kill` is
    set, and that happens only after the relaunch has already finished and
    this thread has already read the entry's post-relaunch state.
    """
    kernel_id = kernel_id_for(identity_for("k1"))
    entry = registry._entries[kernel_id]  # noqa: SLF001
    old_kernel = entry.kernel
    assert old_kernel is not None
    idled(registry, "k1", seconds=40 * 60)

    reached_kill = threading.Event()
    may_finish_kill = threading.Event()
    real_stop = old_kernel.stop

    def paused_stop() -> None:
        reached_kill.set()
        may_finish_kill.wait(timeout=10)
        real_stop()

    monkeypatch.setattr(old_kernel, "stop", paused_stop)

    reclaiming: dict[str, Any] = {}
    worker = threading.Thread(
        target=lambda: reclaiming.update(
            result=registry.reclaim(total_memory=8 * GB, holding=8 * GB)
        )
    )
    worker.start()
    assert reached_kill.wait(timeout=10), "reclaim() never reached the kill"
    # Past reclaim()'s first locked block: the handle is already dropped and
    # the flag its post-kill block will read is already set.
    assert entry.kernel is None
    assert entry.reclaim_requested is True

    # The relaunch that wins the race, run to completion on this thread while
    # the kill sits parked on the `Event` above and can observe none of it.
    result = host.execute("k1", "print('back')")
    assert result["ok"] is True
    assert entry.reclaim_requested is False  # `_replace` already cleared it
    live_probe = entry.probe
    assert live_probe is not None
    incarnation_after_relaunch = entry.incarnation

    may_finish_kill.set()
    worker.join(timeout=10)
    assert not worker.is_alive()

    # `reclaim()` still ran the kill it started against the old process — that
    # part already happened and cannot be undone — but the entry it would
    # have stamped now holds a different, live incarnation, and the fix is
    # that it leaves that incarnation entirely alone.
    assert reclaiming["result"] == kernel_id
    assert entry.reclaimed_ts is None
    assert entry.probe is live_probe
    assert entry.incarnation == incarnation_after_relaunch
    assert state_of(registry, kernel_id) == "idle"


def test_a_ceiling_of_one_hundred_percent_reclaims_nothing(host, registry):
    idled(registry, "k1", seconds=400 * 60)
    registry.reclaim(total_memory=8 * GB, holding=8 * GB, share=1.0)
    assert not any(entry["state"] == "reclaimed" for entry in registry.list())


def test_a_language_absent_from_the_prefix_map_is_never_launched(registry):
    # The one new way the invariant — that no argument list reachable from
    # this host puts an interpreter outside a boundary — could have been
    # broken by making the prefix plural.
    registry.configure_session(
        session_id="ses_1",
        task_id="task_1",
        workspace=None,
        prefixes={"r": ["/usr/bin/env"]},
        environments={"r": "r"},
    )
    identity = KernelIdentity(session_id="ses_1", task_id="task_1", name="main", language="python")
    with pytest.raises(ValueError, match="no confinement was supplied"):
        registry.execute(identity, "1", origin={"surface": "agent", "by": "claude"})
