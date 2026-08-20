"""The chain that says what state a namespace was in when a cell ran."""

import copy
import hashlib
import secrets
import sys
import threading
from pathlib import Path
from typing import Any, Iterator, NamedTuple

import pytest

from lykeion_kernel.kernels import KernelIdentity
from lykeion_kernel.provenance.envelope import envelope_hash, lineage_next, lineage_seed
from lykeion_kernel.provenance.store import ProvenanceStore
from lykeion_kernel.registry import Registry, kernel_id_for

ORIGIN = {"surface": "repl", "by": "m_1"}
IDENTITY = KernelIdentity(
    session_id="ses_1", task_id="tk_1", name="k1", language="python", environment="python",
)
# What a daemon that reached a repository behind a workspace says about it.
A_REPOSITORY: dict[str, Any] = {
    "status": "available",
    "value": {"repository": "/w", "branch": "trunk", "commit": "c" * 40, "dirty": False},
}


class Recording(NamedTuple):
    """A registry that keeps a record of every cell, the identity those cells
    run under, and the store the records land in."""

    registry: Registry
    identity: KernelIdentity
    store: ProvenanceStore


@pytest.fixture
def registry_with_store(prefix: list[str], tmp_path: Path) -> Iterator[Recording]:
    """A registry writing its records somewhere the test can read them back,
    and whose kernels have all ended by the time that test returns."""
    store = ProvenanceStore(tmp_path / "provenance")
    holding = Registry(prefix, store=store)
    try:
        yield Recording(holding, IDENTITY, store)
    finally:
        holding.shutdown()


def a_cell_that_does_not_end(
    registry: Registry, identity: KernelIdentity, tmp_path: Path, until: Any
) -> dict[str, Any]:
    """A cell running in its own thread, handed back once it is really running.

    Waited for on a marker the cell itself writes rather than on a sleep: a
    signal sent before the cell reached its loop is one the kernel is deaf
    to, and the test that sent it would hang rather than fail.
    """
    marker = tmp_path / "running"
    landed: dict[str, Any] = {}
    running = threading.Thread(
        target=lambda: landed.update(
            cell=registry.execute(
                identity,
                f"import time\nopen({str(marker)!r}, 'w').close()\n"
                "while True:\n    time.sleep(0.05)",
                origin=ORIGIN,
            )
        )
    )
    running.start()
    until(marker.exists, "the cell to reach its loop")
    landed["thread"] = running
    return landed


def joined(landed: dict[str, Any]) -> dict[str, Any]:
    """The cell, once the thread running it has come back."""
    landed["thread"].join(timeout=10)
    assert not landed["thread"].is_alive(), "this cell never came back"
    return landed["cell"]


def test_the_seed_is_over_the_kernel_and_its_incarnation() -> None:
    assert lineage_seed("k_1", 0) == hashlib.sha256(b"k_1\x000").hexdigest()


def test_a_restart_seeds_a_different_chain() -> None:
    # A restart wipes the namespace, and the chain exists to say so. Two
    # incarnations of one kernel sharing a seed would be the chain claiming
    # the opposite.
    assert lineage_seed("k_1", 0) != lineage_seed("k_1", 1)


def test_two_kernels_do_not_share_a_chain() -> None:
    assert lineage_seed("k_1", 0) != lineage_seed("k_2", 0)


def test_each_link_folds_the_previous_digest_and_the_new_id() -> None:
    seed = lineage_seed("k_1", 0)
    assert lineage_next(seed, "p_1") == hashlib.sha256(f"{seed}\x00p_1".encode()).hexdigest()


def test_the_chain_depends_on_order() -> None:
    seed = lineage_seed("k_1", 0)
    one_then_two = lineage_next(lineage_next(seed, "p_1"), "p_2")
    two_then_one = lineage_next(lineage_next(seed, "p_2"), "p_1")
    assert one_then_two != two_then_one


def test_the_chain_is_stable_for_one_history() -> None:
    seed = lineage_seed("k_1", 0)
    walk = lineage_next(lineage_next(seed, "p_1"), "p_2")
    again = lineage_next(lineage_next(lineage_seed("k_1", 0), "p_1"), "p_2")
    assert walk == again


def test_a_restart_resets_the_chain_on_the_entry(registry: Registry) -> None:
    kernel_id = kernel_id_for(IDENTITY)
    registry.execute(IDENTITY, "x = 1", origin=ORIGIN)
    before = registry._entry_for(kernel_id, IDENTITY)
    walked, incarnation = before.lineage_digest, before.incarnation

    registry.restart(kernel_id)
    registry.execute(IDENTITY, "x = 1", origin=ORIGIN)
    after = registry._entry_for(kernel_id, IDENTITY)

    assert after.incarnation == incarnation + 1
    assert after.lineage_digest != walked
    # One, not two: the restart wiped the namespace and the chain with it, so
    # the cell after it is the first of a new incarnation rather than the
    # second of the one that is gone.
    assert after.lineage_index == 1


def test_a_cell_carries_its_envelope_and_the_id_that_names_it(registry_with_store) -> None:
    registry, identity, store = registry_with_store
    cell = registry.execute(identity, "x = 1", origin={"surface": "repl", "by": "m_1"})

    assert cell["provenanceId"] == store.put_envelope(cell["provenance"])
    assert store.read_envelope(cell["provenanceId"]) == cell["provenance"]


def test_the_envelope_names_the_cell_it_describes(registry_with_store) -> None:
    registry, identity, _ = registry_with_store
    cell = registry.execute(identity, "x = 1", origin={"surface": "repl", "by": "m_1"})
    assert cell["provenance"]["identity"]["kernelId"] == cell["kernelId"]
    assert cell["provenance"]["identity"]["taskId"] == identity.task_id


def test_the_envelopes_items_are_the_hash_of_the_cells_own_outputs(registry_with_store) -> None:
    # Hashed from the SAME outputs the cell reports, inside the one turn
    # that produces both — a record whose items came from anywhere else
    # could name a cell that ran differently from the one beside it.
    registry, identity, _ = registry_with_store
    cell = registry.execute(identity, "6 * 7", origin={"surface": "repl", "by": "m_1"})

    items = cell["provenance"]["outputs"]["items"]
    assert len(items) == 1
    assert items[0]["sha256"] == hashlib.sha256(b"42").hexdigest()
    assert cell["outputs"][0]["data_ref"]["text/plain"]["sha256"] == items[0]["sha256"]


def test_a_failed_cell_is_recorded_as_failed_rather_than_left_out(registry_with_store) -> None:
    registry, identity, _ = registry_with_store
    cell = registry.execute(identity, "raise ValueError('x')", origin={"surface": "repl", "by": "m"})
    assert cell["ok"] is False
    assert cell["provenance"]["outputs"]["status"] == "failed"


def test_the_second_cell_names_the_first_as_its_parent(registry_with_store) -> None:
    registry, identity, _ = registry_with_store
    first = registry.execute(identity, "x = 1", origin={"surface": "repl", "by": "m_1"})
    second = registry.execute(identity, "y = 2", origin={"surface": "repl", "by": "m_1"})

    lineage = second["provenance"]["input"]["codeState"]["lineage"]
    assert lineage["parent"] == first["provenanceId"]
    assert lineage["index"] == 1


def test_the_first_cell_of_an_incarnation_names_no_parent(registry_with_store) -> None:
    # Absent, never an empty string: there is no predecessor, and a key
    # holding "" would be this record claiming there was one.
    registry, identity, _ = registry_with_store
    first = registry.execute(identity, "x = 1", origin={"surface": "repl", "by": "m_1"})
    assert "parent" not in first["provenance"]["input"]["codeState"]["lineage"]


def test_the_first_cell_after_a_restart_names_no_parent(registry_with_store) -> None:
    # The restart took the namespace the earlier cell built. A record naming
    # it as this cell's parent would be the chain asserting continuity across
    # the one event that breaks it.
    registry, identity, _ = registry_with_store
    registry.execute(identity, "x = 1", origin=ORIGIN)
    registry.restart(kernel_id_for(identity))
    after = registry.execute(identity, "y = 2", origin=ORIGIN)

    lineage = after["provenance"]["input"]["codeState"]["lineage"]
    assert "parent" not in lineage
    assert lineage["index"] == 0


def test_the_status_is_never_queued_or_running(registry_with_store) -> None:
    # The id is the hash of the body, so a record that changed as a cell
    # progressed would change identity under every cell referencing it.
    registry, identity, _ = registry_with_store
    cell = registry.execute(identity, "x = 1", origin={"surface": "repl", "by": "m_1"})
    assert cell["provenance"]["outputs"]["status"] in {
        "succeeded",
        "failed",
        "cancelled",
        "interrupted",
    }


def test_the_cell_and_the_record_agree_on_what_the_cell_is_called(registry_with_store) -> None:
    # The join between the two: a record naming a cell nothing else names is
    # a record nothing can be read back through.
    registry, identity, _ = registry_with_store
    cell = registry.execute(identity, "x = 1", origin=ORIGIN)
    assert cell["provenance"]["identity"]["cellId"] == cell["id"]


def test_two_cells_are_two_records(registry_with_store) -> None:
    registry, identity, _ = registry_with_store
    first = registry.execute(identity, "x = 1", origin=ORIGIN)
    second = registry.execute(identity, "y = 2", origin=ORIGIN)
    assert first["id"] != second["id"]
    assert first["provenanceId"] != second["provenanceId"]


def confined(registry: Registry, identity: KernelIdentity, tmp_path: Path) -> Path:
    """A session whose kernels run inside a workspace, and that workspace."""
    workspace = tmp_path / "task"
    workspace.mkdir()
    registry.configure_session(
        session_id=identity.session_id,
        task_id=identity.task_id,
        workspace=str(workspace),
        environments=[
            {
                "language": "python",
                "name": "python",
                "interpreter": sys.executable,
                "prefix": ["/usr/bin/env"],
                "default": True,
            }
        ],
    )
    return workspace


def keys_of(value: Any) -> Any:
    """The shape of a record: every key at every depth, and nothing of what
    is under them."""
    if isinstance(value, dict):
        return {key: keys_of(inner) for key, inner in value.items()}
    return None


def test_the_record_names_the_directory_the_cell_ran_in(
    registry_with_store, tmp_path: Path
) -> None:
    registry, identity, _ = registry_with_store
    workspace = confined(registry, identity, tmp_path)
    cell = registry.execute(identity, "x = 1", origin=ORIGIN)
    assert cell["provenance"]["input"]["cwd"] == str(workspace)


def test_the_record_carries_exactly_the_keys_the_contract_names(
    registry_with_store, tmp_path: Path
) -> None:
    # Pinned whole rather than field by field. A record is addressed by the
    # hash of its own bytes, so a key dropped or misspelled here is not a
    # field that reads empty — it is a different record of the same cell, and
    # the first thing to notice would be a server that can join nothing to it.
    #
    # The SECOND cell of a confined session, because that is the shape with
    # every optional key present at once: `cwd` for the workspace it ran in,
    # `parent` for the cell in front of it.
    registry, identity, _ = registry_with_store
    confined(registry, identity, tmp_path)
    registry.execute(identity, "x = 1", origin=ORIGIN)
    cell = registry.execute(identity, "y = 2", origin=ORIGIN)

    assert keys_of(cell["provenance"]) == {
        "version": None,
        "identity": {"taskId": None, "sessionId": None, "kernelId": None, "cellId": None},
        "input": {
            "code": None,
            "cwd": None,
            "codeState": {
                "lineage": {
                    "incarnation": None,
                    "index": None,
                    "digest": None,
                    "parent": None,
                },
                "git": {"status": None, "reason": None},
            },
        },
        "environment": {
            "host": {
                "platform": None,
                "arch": None,
                "runtimes": {"status": None, "reason": None},
            },
            "kernel": {
                "id": None,
                "language": None,
                "incarnation": None,
                "processId": None,
                "processStartedAt": None,
            },
        },
        "outputs": {"status": None, "items": None},
        "timestamps": {"createdAt": None, "startedAt": None, "completedAt": None},
    }


def test_a_store_that_cannot_be_written_to_does_not_cost_the_cell(registry_with_store) -> None:
    # The priority, stated as an assertion: a cell is the record of work that
    # happened, and the envelope is a record ABOUT it. The envelope is named
    # without the store and travels up beside the cell on its own frame, so a
    # disk that will not take it costs a local copy of something the lab is
    # being told anyway — while a raise would cost the outputs themselves.
    registry, identity, store = registry_with_store
    announced: list[dict[str, Any]] = []
    registry.on_cell = announced.append

    def refuse(_envelope: dict[str, Any]) -> str:
        raise OSError("no space left on device")

    store.put_envelope = refuse
    cell = registry.execute(identity, "print('kept')", origin=ORIGIN)

    assert announced == [cell]
    assert cell["ok"] is True
    assert cell["outputs"][0]["text"] == "kept\n"
    assert cell["provenanceId"] == envelope_hash(cell["provenance"])
    assert store.read_envelope(cell["provenanceId"]) is None


def test_a_session_confined_without_a_workspace_names_no_directory(registry_with_store) -> None:
    # Absent, never "": a record naming a directory nothing ran in is worse
    # than one saying nothing about where the cell ran.
    registry, identity, _ = registry_with_store
    cell = registry.execute(identity, "x = 1", origin=ORIGIN)
    assert "cwd" not in cell["provenance"]["input"]


def test_a_host_nothing_has_told_about_a_repository_says_so(registry_with_store) -> None:
    # Three-valued, and this is the third: not a repository that is clean and
    # not one that is dirty, but nobody having said either way.
    registry, identity, _ = registry_with_store
    cell = registry.execute(identity, "x = 1", origin=ORIGIN)
    assert cell["provenance"]["input"]["codeState"]["git"] == {
        "status": "unavailable",
        "reason": "not_captured",
    }


def test_the_record_carries_what_the_daemon_last_said(registry_with_store) -> None:
    registry, identity, _ = registry_with_store
    registry.set_code_state(identity.session_id, A_REPOSITORY)
    cell = registry.execute(identity, "x = 1", origin=ORIGIN)
    assert cell["provenance"]["input"]["codeState"]["git"] == A_REPOSITORY


def test_what_the_daemon_said_is_copied_rather_than_held(registry_with_store) -> None:
    # A record is named by the hash of its own bytes. A caller still able to
    # reach inside what it handed over would be moving bytes that have already
    # been hashed and named, and the record would go on claiming the name of
    # something it no longer is.
    #
    # The mutation is of the NESTED value rather than the top level, because
    # that is the half a shallow copy leaves reachable — and `dirty` flipping
    # under a daemon that reuses one object is the likeliest way it happens.
    registry, identity, _ = registry_with_store
    said: dict[str, Any] = copy.deepcopy(A_REPOSITORY)
    registry.set_code_state(identity.session_id, said)
    cell = registry.execute(identity, "x = 1", origin=ORIGIN)
    said["value"]["dirty"] = True

    assert cell["provenance"]["input"]["codeState"]["git"] == A_REPOSITORY
    assert cell["provenanceId"] == envelope_hash(cell["provenance"])


def test_one_sessions_repository_never_reaches_another_sessions_cell(
    registry_with_store,
) -> None:
    """Two Tasks taking turns at once, and a repository behind one of them.

    What the daemon says is a fact about ONE workspace, and this host holds
    every session on the machine. A record is immutable and named by the hash
    of its own bytes, so a cell stamped with the other Task's branch and
    commit is a cell nothing afterwards can correct — and the same envelope
    already names its own session's `cwd`, which would then sit beside
    another session's repository inside one record.
    """
    registry, mine, _ = registry_with_store
    theirs = KernelIdentity(
        session_id="ses_2", task_id="tk_2", name="k1",
        language="python", environment="python",
    )
    registry.set_code_state(theirs.session_id, A_REPOSITORY)

    ran_in_mine = registry.execute(mine, "x = 1", origin=ORIGIN)
    ran_in_theirs = registry.execute(theirs, "x = 1", origin=ORIGIN)

    assert ran_in_mine["provenance"]["input"]["codeState"]["git"] == {
        "status": "unavailable",
        "reason": "not_captured",
    }
    assert ran_in_theirs["provenance"]["input"]["codeState"]["git"] == A_REPOSITORY


def test_what_the_daemon_said_goes_when_the_session_does(registry_with_store) -> None:
    # A session that closed and one that never opened reach the same
    # distance, which is none — and what was said about the first one's
    # workspace is not a fact about any session that comes after it.
    registry, identity, _ = registry_with_store
    registry.set_code_state(identity.session_id, A_REPOSITORY)
    registry.release_session(identity.session_id)

    cell = registry.execute(identity, "x = 1", origin=ORIGIN)
    assert cell["provenance"]["input"]["codeState"]["git"] == {
        "status": "unavailable",
        "reason": "not_captured",
    }


def test_a_restart_racing_the_record_lands_after_it_rather_than_inside_it(
    registry_with_store, until
) -> None:
    """A restart asked for while a cell's record is being assembled.

    The record is built while the entry's turn is still held, and `restart()`
    waits on that same turn — so the restart lands after the record is whole
    or not at all. What this holds is that the record describes the
    incarnation the cell actually ran in, rather than being assembled out of
    facts half of which the restart has already replaced.

    The moment chosen is the cell's own name being minted, which is the first
    thing that happens once the cell has settled and before any of the record
    is read. A restart asked for there is asked for as early as anything can
    ask. The registry, the kernels, the store and the restart are all real.
    """
    registry, identity, store = registry_with_store
    kernel_id = kernel_id_for(identity)
    first = registry.execute(identity, "x = 1", origin=ORIGIN)
    entry = registry._entry_for(kernel_id, identity)
    minting = secrets.token_urlsafe
    restarting = threading.Thread(target=lambda: registry.restart(kernel_id))

    def restart_then_mint(length: int) -> str:
        secrets.token_urlsafe = minting
        restarting.start()
        # Waited for on a fact rather than on a clock. `Turn.place` appends
        # before `taken` blocks, so a depth of one is the restart committed
        # to this queue and unable to go further — which is the thing being
        # asserted, established rather than timed out. The other half of the
        # condition is what keeps this discriminating: a registry that read
        # the chain out here leaves the turn free, so the restart runs
        # straight through and is finished rather than waiting.
        until(
            lambda: entry.turn.depth == 1 or not restarting.is_alive(),
            "the restart to commit to this kernel's queue",
        )
        return minting(length)

    secrets.token_urlsafe = restart_then_mint
    try:
        second = registry.execute(identity, "y = 2", origin=ORIGIN)
    finally:
        secrets.token_urlsafe = minting
        restarting.join(timeout=10)

    record = second["provenance"]
    lineage = record["input"]["codeState"]["lineage"]
    assert record["environment"]["kernel"]["incarnation"] == 1
    assert lineage["incarnation"] == 1
    assert lineage["index"] == 1
    assert lineage["parent"] == first["provenanceId"]
    assert store.read_envelope(second["provenanceId"]) == record

    assert not restarting.is_alive()
    assert entry.incarnation == 2
    assert entry.lineage_index == 0
    assert entry.lineage_parent is None


def test_the_cell_behind_folds_onto_the_one_in_front_when_their_tails_overlap(
    registry_with_store,
) -> None:
    """Two cells of one kernel whose tails overlap, and the link between them.

    The cells themselves are ordered by the turn; what is not obviously
    ordered is what each does AFTER its own cell has run. If the cell in
    front reads the chain, and the one behind reads it too before the first
    has folded its link, then the first's link is overwritten by the second
    and is simply gone — a chain that claims to be the fold of every cell
    that built a namespace, missing one.

    The moment chosen is the write, because in a registry that assembles a
    record in its tail the write sits exactly between the chain being read
    and the chain being advanced. Running the cell behind from in there is
    the overlap, made to happen rather than waited for.
    """
    registry, identity, store = registry_with_store
    writing = store.put_envelope
    behind: dict[str, Any] = {}

    def run_the_cell_behind_then_write(envelope: dict[str, Any]) -> str:
        store.put_envelope = writing
        running = threading.Thread(
            target=lambda: behind.update(
                cell=registry.execute(identity, "y = 2", origin=ORIGIN)
            )
        )
        running.start()
        running.join(timeout=30)
        assert not running.is_alive(), "the cell behind never came back"
        return writing(envelope)

    store.put_envelope = run_the_cell_behind_then_write
    front = registry.execute(identity, "x = 1", origin=ORIGIN)

    lineage = behind["cell"]["provenance"]["input"]["codeState"]["lineage"]
    assert lineage["index"] == 1
    assert lineage["parent"] == front["provenanceId"]


def test_a_cell_that_waited_behind_another_reports_the_wait(
    registry_with_store, tmp_path: Path, until
) -> None:
    # What the third timestamp is for. A cell held behind another is not a
    # cell that took longer to run, and a record taking both readings at one
    # point would say it was.
    registry, identity, _ = registry_with_store
    marker = tmp_path / "running"
    ahead = threading.Thread(
        target=lambda: registry.execute(
            identity,
            f"import time\nopen({str(marker)!r}, 'w').close()\ntime.sleep(2)",
            origin=ORIGIN,
        )
    )
    ahead.start()
    until(marker.exists, "the cell in front to start")
    behind = registry.execute(identity, "x = 1", origin=ORIGIN)
    ahead.join(timeout=10)

    assert not ahead.is_alive()
    timestamps = behind["provenance"]["timestamps"]
    assert timestamps["startedAt"] > timestamps["createdAt"]
    assert timestamps["completedAt"] >= timestamps["startedAt"]


def test_a_cell_whose_kernel_was_stopped_under_it_is_recorded_as_cancelled(
    registry_with_store, tmp_path: Path, until
) -> None:
    registry, identity, _ = registry_with_store
    landed = a_cell_that_does_not_end(registry, identity, tmp_path, until)
    registry.stop(kernel_id_for(identity), feedback="enough", by="m_1")

    assert joined(landed)["provenance"]["outputs"]["status"] == "cancelled"


def test_an_interrupted_cell_is_recorded_as_interrupted(
    registry_with_store, tmp_path: Path, until
) -> None:
    # Apart from `failed`, which is what a cell that raised on its own did: a
    # researcher reading a notebook back is owed the difference between code
    # that broke and code they ended.
    registry, identity, _ = registry_with_store
    landed = a_cell_that_does_not_end(registry, identity, tmp_path, until)
    registry.interrupt(kernel_id_for(identity))

    assert joined(landed)["provenance"]["outputs"]["status"] == "interrupted"
