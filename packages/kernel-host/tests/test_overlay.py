"""Where a `pip install` inside a cell lands, and how it is noticed.

Two claims, and they are the whole of this file. An install inside a cell
WORKS — it has somewhere writable to land and the interpreter finds it — and
it DOES NOT LAST, because where it lands belongs to one incarnation of one
kernel. Everything else here is in service of noticing it: by the effect it
had on a directory, never by the syntax that caused it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from lykeion_kernel.kernels import KernelIdentity
from lykeion_kernel.overlay import (
    DISCARDED,
    SCRATCH_DIR,
    installed_between,
    launch_env,
    overlay_for,
    overlays_root,
    snapshot,
    sweep_overlays,
)
from lykeion_kernel.registry import Registry, kernel_id_for

ORIGIN = {"surface": "repl", "by": "u_1"}


def an_identity(name: str = "main", session_id: str = "ses_1") -> KernelIdentity:
    return KernelIdentity(
        session_id=session_id, task_id="tk_1", name=name,
        language="python", environment="python",
    )


def confine_session(
    holding: Registry, *, workspace: str | None, session_id: str = "ses_1"
) -> None:
    """One session, confined the way the daemon confines one — and a
    `workspace` of `None` for the one thing the daemon never sends, which a
    caller standing in for it still can."""
    holding.configure_session(
        session_id=session_id,
        task_id="tk_1",
        workspace=workspace,
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


def test_an_install_is_noticed_however_it_was_spelled(tmp_path: Path):
    """The mechanism watches the effect, not the syntax.

    Source scanning is unwinnable — `!pip install`, `%pip`, `subprocess.run`,
    `os.system`, `python -m pip`, `uv pip`, and the next spelling nobody has
    thought of. A directory listing catches all of them.
    """
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    before = snapshot(overlay)
    (overlay / "scanpy").mkdir()
    (overlay / "anndata").mkdir()
    (overlay / "scanpy-1.10.dist-info").mkdir()
    assert installed_between(before, snapshot(overlay)) == ["anndata", "scanpy"]


def test_a_distribution_is_named_once_however_many_entries_it_left(tmp_path: Path):
    """`.dist-info` and `.egg-info` fold into the package they describe.

    A wheel leaves at least two top-level entries and often four. Reported
    entry by entry, one `pip install anndata` would read to an agent as four
    packages having arrived, and the count in the sentence it is handed would
    be wrong by that much on every install.
    """
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    before = snapshot(overlay)
    for entry in (
        "anndata",
        "anndata-0.10.9.dist-info",
        "typing_extensions-4.12.2.dist-info",
        "typing_extensions.py",
        "legacy.egg-info",
        # An install writes these too, and neither is a package a researcher
        # asked for or could add to an environment.
        "__pycache__",
        "bin",
    ):
        if entry.endswith(".py"):
            (overlay / entry).write_text("")
        else:
            (overlay / entry).mkdir()
    assert installed_between(before, snapshot(overlay)) == [
        "anndata",
        "legacy",
        "typing_extensions",
    ]


def test_a_cell_that_wrote_nothing_new_is_an_empty_answer(tmp_path: Path):
    """Absent, not zero — and this is where the absence starts.

    A diff of two snapshots naturally produces an empty list, and every
    surface downstream of this one has to be able to tell "installed nothing"
    from "installed these". It can only do that if this end is honest about
    an empty diff being empty rather than dressing one entry up.
    """
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    (overlay / "scanpy").mkdir()
    before = snapshot(overlay)
    (overlay / "scanpy" / "_core.py").write_text("")
    assert installed_between(before, snapshot(overlay)) == []


def test_an_overlay_that_is_not_there_yet_lists_nothing(tmp_path: Path):
    """A kernel whose overlay nothing has created is not an error.

    `snapshot` is called on the path an entry is holding, and an entry can be
    holding one for a workspace the daemon has since swept. A raise here would
    be a cell that ran fine reported as a failure over a directory listing.
    """
    assert snapshot(tmp_path / "never-made") == frozenset()
    assert snapshot(None) == frozenset()


def test_each_incarnation_gets_its_own_overlay_and_the_last_one_is_dropped(
    tmp_path: Path,
):
    """The disk goes somewhere, and it goes when the incarnation does.

    Per-incarnation is what makes an inline install not last. Left to
    accumulate, a kernel restarted twenty times would leave twenty copies of
    whatever was installed into each under one Task — so creating the next
    one is also what removes every other, which cleans up after a host that
    was killed as well as after an ordinary restart.
    """
    first = overlay_for(str(tmp_path), "k_abc", 1)
    Path(first, "scanpy").mkdir()
    assert os.path.isdir(first)

    second = overlay_for(str(tmp_path), "k_abc", 2)
    assert second != first
    assert os.path.isdir(second)
    assert not os.path.exists(first), "the incarnation that ended kept its packages"

    # Another kernel's overlay is another kernel's: one restart must not take
    # the packages out from under a kernel that never restarted.
    other = overlay_for(str(tmp_path), "k_def", 1)
    Path(other, "anndata").mkdir()
    overlay_for(str(tmp_path), "k_abc", 3)
    assert os.path.isdir(other)


def test_the_overlay_leads_the_path_it_is_laid_over(tmp_path: Path):
    """Ahead of the environment, and never instead of it.

    A kernel that lost its inherited `PYTHONPATH` would be a researcher's own
    machine configuration taken away by a feature about pip; a kernel whose
    overlay came second would import the environment's copy of a package a
    cell just installed a newer one of, and report the old version.
    """
    composed = launch_env("/tmp/overlay", {"PYTHONPATH": f"/a{os.pathsep}/b"})
    assert composed["PIP_TARGET"] == "/tmp/overlay"
    assert composed["PYTHONPATH"] == os.pathsep.join(["/tmp/overlay", "/a", "/b"])
    # An empty component means the current directory on POSIX, and a kernel's
    # current directory is the workspace — the same reason `environment_of`
    # drops them out of `PATH`.
    assert launch_env("/tmp/overlay", {"PYTHONPATH": ""})["PYTHONPATH"] == "/tmp/overlay"
    assert launch_env("/tmp/overlay", {})["PYTHONPATH"] == "/tmp/overlay"


def test_a_cell_can_install_into_the_overlay_and_import_it(
    registry: Registry, tmp_path: Path
):
    """The half that has to WORK: a cell writes where pip would, and the
    interpreter behind that cell can import it.

    Written with `os.makedirs` rather than by running pip, which would put a
    network fetch inside a unit test. What is being asserted is the
    arrangement — `PIP_TARGET` names somewhere writable, and that somewhere is
    on the path this interpreter searches — which is the whole of what pip
    needs from this end.
    """
    confine_session(registry, workspace=str(tmp_path))
    made = registry.execute(
        an_identity("main"),
        "import os, pathlib\n"
        "target = pathlib.Path(os.environ['PIP_TARGET'])\n"
        "target.mkdir(parents=True, exist_ok=True)\n"
        "(target / 'inline_pkg.py').write_text('WHAT = 12\\n')\n"
        "import inline_pkg\n"
        "print(inline_pkg.WHAT)\n",
        origin=ORIGIN,
    )
    assert made["ok"], made["outputs"]
    assert "12" in "".join(
        output.get("text", "") for output in made["outputs"] if output["kind"] == "stream"
    )


def test_a_cell_that_installed_something_says_which(registry: Registry, tmp_path: Path):
    """Noticed by the effect: the cell above names no install syntax at all,
    and is still reported as having installed something."""
    confine_session(registry, workspace=str(tmp_path))
    made = registry.execute(
        an_identity("main"),
        "import os, pathlib\n"
        "target = pathlib.Path(os.environ['PIP_TARGET'])\n"
        "(target / 'scanpy').mkdir(parents=True)\n"
        "(target / 'scanpy-1.10.dist-info').mkdir(parents=True)\n",
        origin=ORIGIN,
    )
    assert made["ok"], made["outputs"]
    assert made["installed"] == ["scanpy"]


def test_a_cell_that_installed_nothing_carries_no_key_at_all(
    registry: Registry, tmp_path: Path
):
    """Absent is not zero, on the cell this time.

    An `installed: []` on every ordinary cell would put the field on every row
    of every notebook in the lab, and a reader that showed the field where it
    was present would then show it everywhere.
    """
    confine_session(registry, workspace=str(tmp_path))
    made = registry.execute(an_identity("main"), "x = 1", origin=ORIGIN)
    assert "installed" not in made


def test_a_restart_drops_what_was_installed_inline(registry: Registry, tmp_path: Path):
    """C-023's own test: install inline, restart, import -> ImportError."""
    confine_session(registry, workspace=str(tmp_path))
    registry.execute(
        an_identity("main"),
        "import os, pathlib\n"
        "target = pathlib.Path(os.environ['PIP_TARGET'])\n"
        "target.mkdir(parents=True, exist_ok=True)\n"
        "(target / 'inline_pkg.py').write_text('WHAT = 12\\n')\n"
        "import inline_pkg\n",
        origin=ORIGIN,
    )
    registry.restart(kernel_id_for(an_identity("main")))
    after = registry.execute(
        an_identity("main"),
        "import inline_pkg",
        origin=ORIGIN,
    )
    assert not after["ok"]
    assert any(
        output.get("ename") == "ModuleNotFoundError"
        for output in after["outputs"]
        if output["kind"] == "error"
    ), after["outputs"]


def test_a_session_with_no_workspace_still_runs_cells(registry: Registry):
    """No Task directory, no overlay — and a cell still runs.

    A confinement the daemon builds always carries a workspace; one a caller
    standing in for it builds need not, and the fallback this host was
    constructed with carries none at all. A kernel that refused to start over
    somewhere to put pip's output would be a machine whose kernels depend on
    a feature about installing things.
    """
    confine_session(registry, workspace=None)
    made = registry.execute(an_identity(), "x = 1", origin=ORIGIN)
    assert made["ok"], made["outputs"]
    assert "installed" not in made


def a_registry(workspace: Path, session_id: str = "ses_1") -> Registry:
    """One host's registry over a Task directory, already confined.

    A function rather than the `registry` fixture because the tests below need
    TWO of them over the same workspace — a host that died and the host that
    replaced it, which is the state `Entry.incarnation` knows nothing about.
    """
    holding = Registry(["/usr/bin/env"])
    confine_session(holding, workspace=str(workspace), session_id=session_id)
    return holding


INSTALL_INLINE_PKG = (
    "import os, pathlib\n"
    "target = pathlib.Path(os.environ['PIP_TARGET'])\n"
    "target.mkdir(parents=True, exist_ok=True)\n"
    "(target / 'inline_pkg.py').write_text('WHAT = 12\\n')\n"
    "import inline_pkg\n"
)


def test_a_new_host_does_not_inherit_what_the_last_one_installed(tmp_path: Path):
    """The claim the whole two-lifetimes design rests on, across the boundary
    that actually breaks it.

    `Entry.incarnation` is a fact about ONE host process's memory. A host that
    was killed — a cell that segfaulted a native library, an OOM, a daemon
    restarting a host that stopped answering — is replaced, and the replacement
    counts from one again. Left to `exist_ok=True`, the new incarnation 1 opens
    the dead host's incarnation 1 and finds every package still in it: present
    in the namespace, and claimed by no cell anywhere.

    So the overlay is created EMPTY, always, rather than trusting a counter not
    to collide. A counter that must never repeat across process restarts is a
    fact about memory pretending to be a fact about disk, and the next thing
    that resets it breaks this again.
    """
    first = a_registry(tmp_path)
    try:
        made = first.execute(an_identity(), INSTALL_INLINE_PKG, origin=ORIGIN)
        assert made["ok"], made["outputs"]
        assert made["installed"] == ["inline_pkg"]
    finally:
        first.shutdown()

    second = a_registry(tmp_path)
    try:
        after = second.execute(an_identity(), "import inline_pkg", origin=ORIGIN)
    finally:
        second.shutdown()
    assert not after["ok"], "a new host inherited the last one's inline install"
    assert any(
        output.get("ename") == "ModuleNotFoundError"
        for output in after["outputs"]
        if output["kind"] == "error"
    ), after["outputs"]


def test_an_overlay_is_made_empty_even_where_one_is_already_there(tmp_path: Path):
    """The same rule, asked of `overlay_for` directly.

    Its own number is not evidence that the directory behind it is this
    incarnation's — only having just emptied it is.
    """
    first = overlay_for(str(tmp_path), "k_abc", 1)
    Path(first, "scanpy").mkdir()
    again = overlay_for(str(tmp_path), "k_abc", 1)
    assert again == first
    assert os.listdir(again) == []


def overlay_trees(workspace: Path) -> list[str]:
    """Which kernels this Task is holding overlay disk for."""
    root = Path(overlays_root(str(workspace)))
    return sorted(entry.name for entry in root.iterdir()) if root.is_dir() else []


def test_releasing_a_session_takes_its_installed_packages_off_the_disk(
    registry: Registry, tmp_path: Path
):
    """The axis that actually accumulates.

    A kernel's id digests its SESSION, so the per-incarnation sweep never sees
    across one — a Task worked on over twenty sessions in which somebody
    installed a scientific stack would hold twenty copies of it, under a
    dot-directory nobody looks in, on the one disk a researcher keeps data on.
    Nothing else reclaims it: a snapshot walks past `.lykeion`, and a workspace
    is only removed when the lab lets the whole Task go.
    """
    confine_session(registry, workspace=str(tmp_path))
    registry.execute(an_identity(), INSTALL_INLINE_PKG, origin=ORIGIN)
    assert overlay_trees(tmp_path) == [kernel_id_for(an_identity())]

    assert registry.release_session("ses_1") == 1
    assert overlay_trees(tmp_path) == []


def test_a_new_host_reclaims_the_disk_of_the_one_that_died(tmp_path: Path):
    """A host that was killed released nothing, and its kernels are gone.

    So the bound cannot live only on the tidy path. A new host holds no
    entries at all, which makes every tree under this Task unheld — and
    configuring the first session over it is where that disk goes back.
    """
    first = a_registry(tmp_path)
    try:
        first.execute(an_identity(), INSTALL_INLINE_PKG, origin=ORIGIN)
        assert overlay_trees(tmp_path) != []
    finally:
        # Killed, not released: `shutdown` ends the processes and keeps the
        # identities, which is the state a host that was OOM-killed leaves
        # behind minus the tidiness.
        first.shutdown()

    second = Registry(["/usr/bin/env"])
    try:
        confine_session(second, workspace=str(tmp_path))
        assert overlay_trees(tmp_path) == []
    finally:
        second.shutdown()


def test_the_sweep_leaves_another_session_of_the_same_task_alone(
    registry: Registry, tmp_path: Path
):
    """Two sessions can share one Task, and one of them being configured must
    not take the packages out from under the other's running kernel."""
    confine_session(registry, workspace=str(tmp_path), session_id="ses_1")
    registry.execute(an_identity(session_id="ses_1"), INSTALL_INLINE_PKG, origin=ORIGIN)

    confine_session(registry, workspace=str(tmp_path), session_id="ses_2")

    assert overlay_trees(tmp_path) == [kernel_id_for(an_identity(session_id="ses_1"))]
    still = registry.execute(an_identity(session_id="ses_1"), "import inline_pkg", origin=ORIGIN)
    assert still["ok"], still["outputs"]


def test_a_kernel_nothing_is_running_keeps_its_overlay(registry: Registry, tmp_path: Path):
    """A stopped or lazy kernel still owns its packages.

    Its next cell relaunches it under the same identity — but that relaunch is
    a new incarnation and empties the overlay anyway, so what this is really
    about is a sweep keyed on `entry.kernel is not None` reclaiming disk in a
    window where a researcher can still see the kernel on their own screen.
    """
    confine_session(registry, workspace=str(tmp_path))
    registry.execute(an_identity(), INSTALL_INLINE_PKG, origin=ORIGIN)
    registry.stop(kernel_id_for(an_identity()))

    confine_session(registry, workspace=str(tmp_path), session_id="ses_2")
    assert overlay_trees(tmp_path) == [kernel_id_for(an_identity())]


def test_a_version_with_dashes_in_it_does_not_become_part_of_the_name(tmp_path: Path):
    """Folded from the FIRST dash, which is where a distribution's own name
    ends.

    A metadata directory is `<escaped name>-<version>...`, and the escaping
    turns every dash in a name into an underscore — so the first dash is the
    boundary and any dash after it belongs to the version. An sdist install
    leaves `scikit_learn-1.5.0-py3.12.egg-info`; folded from the last dash
    that reads as `scikit_learn-1.5.0`, which the agent would then hand to
    `manage_packages` and which no index has ever heard of.
    """
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    before = snapshot(overlay)
    (overlay / "scikit_learn-1.5.0-py3.12.egg-info").mkdir()
    (overlay / "ruamel.yaml-0.18.6.dist-info").mkdir()
    assert installed_between(before, snapshot(overlay)) == ["ruamel.yaml", "scikit_learn"]


def test_what_an_install_left_half_written_is_not_a_package(tmp_path: Path):
    """pip works through dotted names and leaves them behind on the way.

    An agent told it installed `.tmp8f2` or `~canpy` goes looking for
    something no index holds, and a count that included them would be wrong
    about how much arrived as well as about what.
    """
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    before = snapshot(overlay)
    (overlay / "scanpy").mkdir()
    (overlay / ".lock").write_text("")
    (overlay / ".tmp8f2").mkdir()
    assert installed_between(before, snapshot(overlay)) == ["scanpy"]


def test_an_overlay_lives_where_a_snapshot_will_not_follow_it(tmp_path: Path):
    """The Python half of a coupling no compiler holds together.

    `takeSnapshot` (daemon, `snapshot.ts`) skips exactly one directory name.
    If this module's scratch name and that one ever differ, every package a
    cell installed is copied into the Task's permanent snapshot record — which
    is the opposite of the whole design, and it would happen silently. The
    other half is asserted in `snapshot.test.ts` as an effect rather than as a
    spelling; this is the half that pins the spelling those two share.
    """
    assert SCRATCH_DIR == ".lykeion"
    here = overlay_for(str(tmp_path), "k_abc", 1)
    assert Path(here).is_relative_to(tmp_path / ".lykeion")


def test_a_kernel_never_opens_an_overlay_somebody_else_left_at_its_number(
    registry: Registry, tmp_path: Path
):
    """The emptying, on its own, with the sweep out of the way.

    Both mechanisms answer the host-restart case — the sweep because a new
    host holds no entries, and the emptying because a launch never trusts a
    directory it did not just clear — and the end-to-end test above cannot
    tell which one did it. This one can: the session is configured FIRST, so
    the sweep has already run and seen nothing, and only then is the dead
    host's directory planted at the number the next incarnation will use.

    Which is the point of the ruling. The guarantee should not depend on a
    counter failing to collide, and testing it only through a path where the
    sweep also happens to fire would leave the construction itself unpinned.
    """
    confine_session(registry, workspace=str(tmp_path))
    left = Path(overlays_root(str(tmp_path)), kernel_id_for(an_identity()), "1")
    left.mkdir(parents=True)
    (left / "inline_pkg.py").write_text("WHAT = 12\n")

    after = registry.execute(an_identity(), "import inline_pkg", origin=ORIGIN)
    assert not after["ok"], "a kernel opened an overlay it had not emptied"
    assert any(
        output.get("ename") == "ModuleNotFoundError"
        for output in after["outputs"]
        if output["kind"] == "error"
    ), after["outputs"]


def test_a_sweep_takes_a_tree_inside_the_very_lock_a_cell_files_its_kernel_under(
    registry: Registry, tmp_path: Path
):
    """The check and the act are one step, and this is what makes them one.

    Asked and answered separately there is a window: a cell files its kernel
    and `_replace` lays down a fresh overlay in it, and the removal that was
    already decided on then falls on a live kernel and takes the packages that
    cell just installed. It is not theoretical — `endpoint.py` gives every
    connection its own OS thread, so a tool call and a `configure_session` on
    the control channel really do run at once, and `configure_session` now runs
    mid-session on every environment create and package add.

    Nothing about the outcome can observe the difference, because the whole
    point is that the interleaving is unreachable. What CAN be observed is the
    mutex: `_entry_for` files an entry under it, so a removal performed while
    it is held cannot have a cell land in front of it. A non-blocking acquire
    from this thread answers whether that is so — `threading.Lock` is not
    reentrant, so failing to take it is the lock being held right now.
    """
    taken_under_the_lock: list[bool] = []

    def take() -> None:
        got = registry._lock.acquire(blocking=False)  # noqa: SLF001 - the claim IS the lock
        if got:
            registry._lock.release()  # noqa: SLF001
        taken_under_the_lock.append(not got)

    registry._claim_unheld("k_nothing_here", take)  # noqa: SLF001
    assert taken_under_the_lock == [True], "a sweep removed a tree with the lock free"


def test_a_sweep_asks_nothing_of_a_tree_a_kernel_is_behind(
    registry: Registry, tmp_path: Path
):
    """The other half of that one step: a held id is never handed a `take` to
    run at all, so there is no path where a live kernel's overlay is moved."""
    confine_session(registry, workspace=str(tmp_path))
    registry.execute(an_identity(), "x = 1", origin=ORIGIN)

    offered: list[str] = []
    registry._claim_unheld(  # noqa: SLF001
        kernel_id_for(an_identity()), lambda: offered.append("taken")
    )
    assert offered == []


def test_a_claimed_tree_is_out_of_reach_before_the_decision_returns(tmp_path: Path):
    """Renamed inside the lock, deleted outside it.

    The removal has to be COMPLETE by the time the caller's hold ends — a
    delete merely scheduled for later is a check-then-act pair wearing
    different clothes, and a cell landing in the meantime would find the
    directory still there and write into something on its way out. It also has
    to be cheap, because a registry-wide mutex held across an `rmtree` of a
    scientific stack stops every cell on this machine for as long as that
    takes. A rename is both.
    """
    root = Path(overlays_root(str(tmp_path)))
    (root / "k_dead" / "1").mkdir(parents=True)
    (root / "k_dead" / "1" / "scanpy.py").write_text("")
    still_there: list[bool] = []

    def claim(kernel_id: str, take) -> None:
        take()
        still_there.append((root / kernel_id).exists())

    assert sweep_overlays(str(tmp_path), claim) == ["k_dead"]
    assert still_there == [False], "a taken tree was still reachable by its own name"
    assert list(root.iterdir()) == [], "the bytes were renamed aside and never deleted"


def test_a_sweep_removes_nothing_its_caller_did_not_take(tmp_path: Path):
    """`sweep_overlays` holds no removal of its own.

    It lists, it offers, and it deletes what came back moved. A removal it
    applied itself, after asking, would be the exact pair this shape replaced —
    and it would be reachable again the moment anybody decided the caller's
    answer was enough to act on.
    """
    root = Path(overlays_root(str(tmp_path)))
    for name in ("k_taken", "k_left"):
        (root / name / "1").mkdir(parents=True)
        (root / name / "1" / "scanpy.py").write_text("")

    def claim(kernel_id: str, take) -> None:
        if kernel_id == "k_taken":
            take()

    assert sweep_overlays(str(tmp_path), claim) == ["k_taken"]
    assert (root / "k_left" / "1" / "scanpy.py").exists()
    assert not (root / "k_taken").exists()


def test_a_kernel_that_lands_while_a_sweep_runs_keeps_what_it_installed(
    registry: Registry, tmp_path: Path
):
    """The reviewer's own construction, run against the real decision.

    A predicate that mutates on its own answer is how the race was shown with
    no code change at all: it did what a concurrent `execute()` does — filed an
    entry and laid down a fresh overlay — and the removal that had already been
    decided on then deleted it. Here the same mutation lands BEFORE the
    decision, because before is the only place left: filing an entry takes the
    mutex `_claim_unheld` holds across both halves, so a cell that gets that far
    has already made the tree held.
    """
    confine_session(registry, workspace=str(tmp_path))
    live = kernel_id_for(an_identity())
    root = Path(overlays_root(str(tmp_path)))
    for name in ("k_dead", live):
        (root / name / "1").mkdir(parents=True)
        (root / name / "1" / "somebody-elses.py").write_text("")

    def racing(kernel_id: str, take) -> None:
        if kernel_id == live:
            registry.execute(an_identity(), INSTALL_INLINE_PKG, origin=ORIGIN)
        registry._claim_unheld(kernel_id, take)  # noqa: SLF001

    assert sweep_overlays(str(tmp_path), racing) == ["k_dead"]
    assert (root / live / "1" / "inline_pkg.py").exists(), (
        "a sweep took the packages out from under a kernel that had just landed"
    )


def test_a_sweep_finishes_deleting_what_a_host_that_died_had_renamed_aside(
    tmp_path: Path,
):
    """The failure mode the rename introduces, and its answer.

    Moving a tree out of reach and deleting it are now two steps with an
    unlocked gap between them, so a host killed inside that gap leaves bytes
    behind under the discard name. They are doomed by definition — nothing
    reaches a tree there by any name a kernel knows — so the next sweep
    finishes the job rather than asking anybody about them.

    Asking would be worse than useless: the discard name is not a kernel id,
    so a caller would have to answer about something it has never heard of.
    """
    root = Path(overlays_root(str(tmp_path)))
    left = root / (DISCARDED + "0123456789abcdef")
    (left / "1").mkdir(parents=True)
    (left / "1" / "scanpy.py").write_text("")

    asked: list[str] = []

    def claim(kernel_id: str, take) -> None:
        asked.append(kernel_id)

    assert sweep_overlays(str(tmp_path), claim) == []
    assert asked == [], "a sweep asked its caller about a tree already out of reach"
    assert not left.exists(), "bytes a dead host renamed aside were never reclaimed"
