"""Where a `pip install` inside a cell lands, and how one is noticed.

A cell that installs something is not the same lifetime as an environment.
An environment is declared once in the lab, pinned by a lockfile, and built
identically on every machine; an install inside a cell is one researcher
trying something, on one machine, in one namespace, five minutes ago. Made
permanent it would be a machine that quietly stopped matching the lockfile
every other machine builds from — and the notebook would still say the cell
ran, with nothing anywhere saying what it left behind.

So it lands HERE instead: a directory belonging to one incarnation of one
kernel, inside the Task's own scratch, dropped when that incarnation ends.
The install works, the import works, and the next restart takes it away —
which is what `manage_packages` exists to be the answer to.

**Noticed by its effect, never by its syntax.** Reading the source for an
install is unwinnable: `!pip install`, `%pip`, `subprocess.run`, `os.system`,
`python -m pip`, a Makefile, a shell cell, and the next spelling nobody has
thought of yet. Listing a directory before the cell and after it catches every
one of them, including the ones that have not been invented, and costs one
`os.listdir` per cell.

The exact claim is **every install that lands where pip installs by default**,
which is what `PIP_TARGET` decides. Two things sit outside it, and neither is
noticed here:

- `uv pip install` is REFUSED, not noticed. uv reads `UV_*` and has never
  heard of `PIP_TARGET`, so it aims at the environment itself and the boundary
  denies the write — see `launch_env`, and the tool descriptions in
  `mcp/server.py`, which tell the agent so before it tries.
- An install given an explicit destination elsewhere in the workspace
  (`pip install --target ./libs`) succeeds, is importable once the cell puts
  it on `sys.path`, and is invisible to this diff. It is also indistinguishable
  from a researcher writing files into their own Task directory, which is what
  the workspace is for.
"""

from __future__ import annotations

import os
import shutil
from typing import Callable, Iterable, Mapping
from uuid import uuid4

# The Task directory's own scratch. **This name is load-bearing and is shared
# with code in another language:** `takeSnapshot` (daemon, `snapshot.ts`)
# skips exactly one directory name, read from `SCRATCH_DIR` in `scratch.ts`,
# and if these two ever spell it differently then every package a cell
# installed goes into the Task's permanent snapshot record. Nothing a compiler
# or an import can enforce holds them together, so a test on each side does:
# `test_an_overlay_lives_where_a_snapshot_will_not_follow_it` here, and
# `snapshot.test.ts`'s "leaves an overlay out of the snapshot it takes" there,
# which asserts the EFFECT rather than the spelling.
#
# The one Python definition of it. `kernels/r.py` imports this rather than
# keeping its own, so a Python-side move is one edit rather than two.
SCRATCH_DIR = ".lykeion"
OVERLAYS = "overlays"

# What an install leaves at the top level that is not a package anybody asked
# for. `bin` is where `pip install --target` puts console scripts and
# `__pycache__` is the interpreter's own; naming either to an agent as
# something it installed would send it to `manage_packages` with a name no
# index has ever heard of.
NOT_A_PACKAGE = frozenset({"__pycache__", "bin"})

# What a tree is renamed to on its way out, and the one name under the overlays
# root that is never a kernel. A kernel id is `k_` and hex (`kernel_id_for`), so
# a leading dot cannot collide with one — and a sweep skips these rather than
# asking about them, since a tree already renamed here is one nothing can reach
# by any name a kernel knows.
DISCARDED = ".discarded-"

# The two ways a distribution says its own name at the top level of a target
# directory. Both carry the name the researcher would type; the entries
# beside them carry the name the researcher would import, which is often the
# same and sometimes not.
METADATA_SUFFIXES = (".dist-info", ".egg-info")


def overlays_root(workspace: str) -> str:
    """Where one Task keeps every overlay any of its kernels has ever had."""
    return os.path.join(workspace, SCRATCH_DIR, OVERLAYS)


def overlay_for(workspace: str, kernel_id: str, incarnation: int) -> str:
    """This incarnation's overlay, EMPTY, whatever was at that path before.

    **Emptied, never merely made.** `incarnation` is a fact about one host
    PROCESS's memory: a host that was killed is replaced by one that counts
    from one again, and `makedirs(..., exist_ok=True)` over the dead host's
    incarnation 1 hands the new kernel every package the old one installed —
    importable, and claimed by no cell anywhere. That is not a tidiness bug.
    "Install inline, restart, import → ImportError" is the justification for
    the whole two-lifetimes design, and made that way it would hold only for
    as long as one process happened to stay alive.

    So the guarantee is bought by emptying rather than by numbering. A counter
    that must never collide across process restarts is a fact about memory
    pretending to be a fact about disk, and the next thing that resets it
    would break this again in exactly the same silent way.

    The siblings go too, which is the ordinary case: a kernel restarted twenty
    times leaves one overlay rather than twenty, and a Task holding a large
    scientific stack twenty times over is gigabytes of a researcher's disk
    spent on namespaces that no longer exist. What this does NOT bound is
    every other kernel's tree under this Task — see `sweep_overlays`, which is
    the other half and is where a dead host's whole inheritance goes.

    Removal is by best effort. A leftover directory that will not go is disk
    this could not reclaim; a raise here would be a kernel that refuses to
    start over it, which is a much worse answer to the same problem.
    """
    root = os.path.join(overlays_root(workspace), kernel_id)
    mine = str(incarnation)
    here = os.path.join(root, mine)
    # Everything under this kernel goes, this incarnation's own number
    # included: what makes a directory this incarnation's is having just been
    # emptied, not the number on it.
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(here, exist_ok=True)
    return here


def drop_overlay(workspace: str, kernel_id: str) -> None:
    """Everything one kernel ever installed, gone along with the kernel.

    For a session being released: its kernels are ended and forgotten, and an
    identity nothing can address again is disk nothing will ever read.
    """
    shutil.rmtree(os.path.join(overlays_root(workspace), kernel_id), ignore_errors=True)


class _Take:
    """One overlay tree, moved out of reach — the whole of a sweep's removal.

    A rename and not a delete, and that is the point rather than an
    optimisation. This runs inside the caller's own lock hold (see
    `sweep_overlays`), so it has to be O(1): `rmtree` of a scientific stack is
    thousands of syscalls, and a registry-wide mutex held across it would stop
    every cell on this machine for as long as it took. A rename within one
    filesystem is one syscall, and after it the tree is unreachable by the only
    name anything looks for it under. The bytes go afterwards, unlocked, where
    nothing is waiting.

    A rename that fails is not raised over. It means the tree went between the
    listing and this call — somebody else's sweep, or a researcher clearing
    their own scratch — and there is nothing left to reclaim. Raising would
    take out the `configure_session` this is running inside, which is a session
    that gets no kernels because of a directory that was already gone.
    """

    def __init__(self, whence: str, whither: str) -> None:
        self.whence = whence
        self.whither = whither
        self.moved = False

    def __call__(self) -> None:
        try:
            os.rename(self.whence, self.whither)
        except OSError:
            return
        self.moved = True


def sweep_overlays(
    workspace: str, claim: Callable[[str, Callable[[], None]], None]
) -> list[str]:
    """Every overlay tree under this Task that no kernel is behind, and which
    of them went.

    The bound on the OTHER axis. `overlay_for` reclaims within one kernel; this
    reclaims across them, and it has to exist because a kernel's id digests its
    SESSION — a Task worked on across twenty sessions in which somebody
    installed a scientific stack would otherwise hold twenty copies of it,
    forever, under a dot-directory nobody looks in. `release_session` is the
    tidy path; this is the one that covers a host that died without releasing
    anything, because a new host holds no entries at all and so finds every
    tree here unheld.

    **Nothing here decides what to remove, and nothing here removes anything a
    caller did not hand over.** `claim` is given a tree's name and a `take`
    that moves it out of reach, and the caller runs `take` — or does not — from
    inside whatever it uses to know that the tree is dead. That shape is the
    fix for a real race and not a matter of taste.

    What it replaced was a check-then-act pair: ask `held(tree)`, then remove.
    The reviewer demonstrated the window between them with no code change at
    all, by answering "not held" and, before returning, doing exactly what a
    concurrent `execute()` does — filing an entry and laying down a fresh
    overlay through `overlay_for`. The removal then landed on a LIVE kernel's
    overlay and took the packages a cell had just installed.

    The argument that used to sit here — that the registry files an entry
    before any overlay for it exists — is true, and it proves a narrower thing
    than it was carrying. It rules out an overlay existing before its entry
    does. It does not make a check and an act performed separately into one
    step, and that pair is where the window was. `endpoint.py` gives every
    connection an OS thread of its own, so a cell and a `configure_session`
    genuinely run at once — and `configure_session` now runs mid-session on
    every environment create and every package add, not only when a session
    opens, which is the same moment a host restart makes every tree look dead.

    So the caller's answer and the caller's removal are one step by
    construction: `Registry._claim_unheld` reads `_entries` and runs `take`
    under the single mutex `_entry_for` files an entry under, and nothing can
    land in between because landing means taking that mutex.
    """
    swept: list[str] = []
    root = overlays_root(workspace)
    try:
        trees = os.listdir(root)
    except OSError:
        # No overlay has ever been made under this Task, or the directory is
        # unreadable. Nothing to reclaim either way, and a raise here would be
        # a session that cannot be configured over somebody else's disk.
        return swept
    # Whatever an earlier sweep renamed and did not live to delete — a host
    # killed in the window between the two. Doomed by definition: nothing
    # reaches a tree under this name. Two sweeps racing to delete the same one
    # is two callers removing the same dead bytes, which `ignore_errors`
    # already tolerates.
    doomed = [os.path.join(root, name) for name in trees if name.startswith(DISCARDED)]
    for tree in trees:
        if tree.startswith(DISCARDED):
            continue
        taken = _Take(os.path.join(root, tree), os.path.join(root, DISCARDED + uuid4().hex))
        claim(tree, taken)
        if taken.moved:
            doomed.append(taken.whither)
            swept.append(tree)
    # The bytes, outside whatever the caller was holding. Everything in here is
    # already unreachable, so how long this takes is nobody's wait.
    for gone in doomed:
        shutil.rmtree(gone, ignore_errors=True)
    return swept


def snapshot(overlay: object) -> frozenset[str]:
    """What is at the top level of an overlay right now.

    Top level only, and deliberately: what is wanted is which distributions
    arrived, and a walk of the whole tree would read every file of every
    package a cell just installed — thousands of them, twice, on the path of
    a cell a researcher is waiting for.

    A path that is not there is not an error and answers nothing. This is
    called on whatever an entry is holding, and an entry can be holding a
    path in a workspace the daemon has since swept, or none at all for a
    session confined without one. A raise here would report a cell that ran
    perfectly as a failure over a directory listing.
    """
    if overlay is None:
        return frozenset()
    try:
        return frozenset(os.listdir(overlay))  # type: ignore[arg-type]
    except OSError:
        return frozenset()


def installed_between(before: Iterable[str], after: Iterable[str]) -> list[str]:
    """The distributions that arrived between two snapshots, sorted by name.

    `.dist-info` and `.egg-info` entries are folded into the package they
    describe rather than counted beside it. One `pip install anndata` leaves
    `anndata/`, `anndata-0.10.9.dist-info/` and usually `__pycache__/` — read
    entry by entry that is one install reported as three arrivals, and the
    count in the sentence the agent is handed would be wrong by that much
    every single time.

    Folded BY NAME, which is exact for the ordinary case and imperfect for
    one: a distribution whose importable name differs from its own —
    `PyYAML` installing `yaml/` — is named twice, once as each. That is the
    honest failure mode and the one worth having, because the alternative is
    picking one of the two names and being silently wrong about which
    package a researcher would have to add to their environment. Answering it
    properly means reading each `.dist-info`'s `RECORD`, which needs the
    overlay's path rather than two listings of it, and is a change to this
    function's shape rather than to its rule.
    """
    named: set[str] = set()
    for entry in set(after) - set(before):
        # A dotfile is not a distribution. `pip` leaves `.lock` files and
        # partially-written trees under names beginning with a dot, and an
        # agent told it installed `.tmp8f2` would go looking for it.
        if entry.startswith(".") or entry in NOT_A_PACKAGE:
            continue
        named.add(_distribution(entry))
    return sorted(named)


def launch_env_r(overlay: str) -> dict[str, str]:
    """What an R kernel is given so an `install.packages()` inside a cell can
    work, and stop working when the host restarts.

    One variable where Python needs two. `R_LIBS_USER` is both where
    `install.packages()` writes by default AND a directory R puts on
    `.libPaths()` at startup — so unlike `PIP_TARGET`/`PYTHONPATH`, there is
    no way to set the write side without the read side and produce the
    install-that-cannot-be-imported failure. It only counts if the directory
    EXISTS when R starts, which is why this takes a path `overlay_for` has
    already made rather than composing one.

    **Nothing is inherited into it, and that is the difference from
    `launch_env`.** Python's `PYTHONPATH` is prepended to whatever the
    researcher had, because that is something they put on their own machine.
    R's equivalent is deliberately swept: `EFFACED` strips `R_LIBS_USER`,
    `R_LIBS` and `R_LIBS_SITE` from a kernel's inheritance, so that a script
    cannot work here because this machine happens to hold a package in the
    researcher's personal library. Prepending here would hand back exactly
    what that sweep exists to take away — so this SETS, and the overlay is
    the only user library an R kernel has.

    The environment's own library is untouched and still found: it lives
    inside the conda prefix R is started from, on `.libPaths()` by virtue of
    being that R's own site library rather than by any variable.
    """
    return {"R_LIBS_USER": overlay}


def launch_env(overlay: str, inherited: Mapping[str, str]) -> dict[str, str]:
    """What a Python kernel is given so an install inside a cell can work.

    Two variables, and they are two halves of one arrangement: `PIP_TARGET`
    is where an install WRITES, and `PYTHONPATH` is where the interpreter
    LOOKS. Either one alone is an install that appears to succeed and then
    cannot be imported, which reads to a researcher as their own machine
    being broken.

    **The overlay leads, and does not replace.** Ahead of the environment,
    because a cell that installed a newer version of something the
    environment already holds meant the newer one. Prepended rather than
    substituted, because an inherited `PYTHONPATH` is something the
    researcher put on their own machine, and a feature about pip is no reason
    to take it away — the same judgement `environment_of` records for this
    variable, and the reason it does not sweep it. Empty components are
    dropped for the reason `environment_of` drops them out of `PATH`: on
    POSIX an empty component means the current directory, and a kernel's
    current directory is the Task's workspace.

    **Why this is not the hazard a writable environment is.** The overlay is
    writable; the environment must not be, and Lykeion asserts both against
    the operating system together (`sandbox.kernel.test.ts`). They are not
    the same risk. The overlay lives inside the Task directory the cell can
    already write, is named only by variables this machine sets on the
    process it starts, and is read only by kernels that are already inside
    the boundary. A writable ENVIRONMENT is a different thing entirely: it is
    where a cell can leave a `sitecustomize.py`, and that file is executed by
    the next interpreter started from that environment — which may be a
    researcher's own shell, outside any boundary at all.

    **What `PIP_TARGET` here does and does not cover.** `EFFACED` in
    `kernels/__init__.py` does not sweep `PIP_TARGET`, `PYTHONUSERBASE`,
    `UV_PROJECT_ENVIRONMENT` or `UV_PYTHON` out of what this host inherited.
    For a PYTHON kernel this function settles the first of those by writing
    it: whatever the host was started with, the kernel is given this overlay.
    It settles none of the others, and it settles nothing for a SHELL cell's
    own child processes beyond the environment they inherit from that kernel —
    a `uv pip install` reads `UV_*` and has never heard of `PIP_TARGET`, so it
    aims at the environment itself and is refused there by the boundary.
    Contained, but not redirected.

    `PIP_PREFIX` WAS on that list and is now swept, because it is the one of
    them that breaks this arrangement rather than sidestepping it: pip refuses
    `--target` and `--prefix` together, so an inherited `PIP_PREFIX` turns
    every inline install into `ERROR: Cannot set --home and --prefix
    together`. The rest are contained by the boundary; that one is a shipped
    feature a researcher can switch off from their own shell profile without
    ever knowing they did.
    """
    carried = [part for part in (inherited.get("PYTHONPATH") or "").split(os.pathsep) if part]
    return {
        "PIP_TARGET": overlay,
        "PYTHONPATH": os.pathsep.join([overlay, *carried]),
    }


def _distribution(entry: str) -> str:
    """The name one top-level entry says its distribution is called.

    A metadata directory is `<escaped name>-<version>.dist-info`, and the
    escaping turns every run of non-alphanumerics — the `-` in a name among
    them — into `_`. So the name is everything before the FIRST `-`, which is
    also what leaves `Name-1.0-py3.12.egg-info` at `Name` rather than at
    `Name-1.0`.

    Anything else is reported as it is written, minus a `.py` on a
    single-module distribution, so that `six.py` and `six-1.16.dist-info`
    are one name rather than two.
    """
    for suffix in METADATA_SUFFIXES:
        if entry.endswith(suffix):
            return entry[: -len(suffix)].split("-", 1)[0]
    return entry[:-3] if entry.endswith(".py") else entry
