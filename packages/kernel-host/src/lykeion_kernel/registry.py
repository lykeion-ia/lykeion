"""Which kernels this machine is holding, and which cell runs next in each.

A kernel outlives its own process: the identity is what a session addresses,
and a restart replaces what is behind it while keeping the name every call
already uses. Entries appear on the first cell run against an identity, so a
machine holds kernels for the work that happened rather than for the work
that was planned.
"""

from __future__ import annotations

import hashlib
import os
import sys
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from .interpreters import Runnable, runnables
from .kernels import Kernel, KernelIdentity
from .kernels.python import launch as launch_python
from .kernels.r import launch as launch_r
from .overlay import (
    drop_overlay,
    installed_between,
    launch_env,
    overlay_for,
    snapshot,
    sweep_overlays,
)
from .sampler import Probe, Sample

# One launcher per language this host can start a kernel in, called with the
# identity, the prefix the daemon rendered, the interpreter to run, the
# directory to run it in, and whatever this incarnation is given on top of
# what its environment says — the overlay an inline install lands in, today.
Launcher = Callable[
    [KernelIdentity, list[str], str, "str | None", "dict[str, str] | None"], Kernel
]

# A language with no row here is refused by name. Nothing consults a second
# list of names kept beside this one, so "can be started" and "is published"
# are one fact rather than two that can drift apart.
LAUNCHERS: dict[str, Launcher] = {"python": launch_python, "r": launch_r}

# How many readings a kernel's ring holds. See `Entry.ring` for why this many.
RING = 8

# What share of a machine this lab's kernels may hold before the oldest idle
# one is taken back. A judgement rather than a measurement: a laptop is also
# carrying a browser, an agent CLI and an editor, and kernels alone past about
# two-thirds of memory is already a machine in trouble. Configurable because
# this default is the weakest part of the policy.
DEFAULT_SHARE = 0.6
# Below this, a kernel is not a candidate however tight the machine is.
# Without it, a researcher alternating between two Tasks would have whichever
# they just left taken, repeatedly — thrashing the exact workflow the tree on
# the Runtimes screen exists to support.
IDLE_FLOOR_S = 300


def _stopped_cell(reason: str | None, by: str | None, execution_count: int) -> dict[str, Any]:
    """What a cell somebody ended looks like to the agent that was running it.

    One `error` output and nothing else: a Python cell killed mid-flight has
    produced nothing this end can read, and R handing back more than Python
    would put a branch on language into a researcher's notebook.

    Counted at whatever the kernel had reached, not at zero: a kernel that had
    run nine cells is not one that has run none, and the record saying a person
    ended it is the last place to lose the count.
    """
    said = f"{by} stopped this kernel" if by else "this kernel was stopped"
    message = f"{said}: {reason}" if reason else said
    return {
        "ok": False,
        "execution_count": execution_count,
        "outputs": [
            {
                "kind": "error",
                "ename": "KernelStopped",
                "evalue": message,
                "traceback": [message],
            }
        ],
    }


def kernel_id_for(identity: KernelIdentity) -> str:
    """The name every call uses for this kernel.

    A digest of what makes it that kernel, so the kernel a lab saw yesterday
    is the same kernel today — a counter would restart with the process
    holding it — and so nothing of a session's own naming is put in front of
    a researcher. Joined on a byte no field can hold, so two identities
    cannot run into each other and mint one name.
    """
    parts = "\0".join([
        identity.session_id, identity.task_id, identity.name,
        identity.language, identity.environment,
    ])
    return f"k_{hashlib.sha256(parts.encode('utf-8')).hexdigest()[:16]}"


class Place:
    """One cell's place in the queue of the kernel it was addressed to.

    Taken and waited on separately, because the two happen in different
    places: the order a kernel's cells arrived in exists on the stream they
    arrived on and nowhere after it, while waiting for the cell in front is
    done wherever this cell is going to run.

    Carries the identity it was taken for, not only the turn. `identity_for`
    reads live session state, so the thread that takes a place and the thread
    that later runs the cell can resolve two different identities if a
    session is reconfigured in between — and `kernel_id_for` is a digest of
    the identity, so a second resolution is a second kernel, whose turn this
    place was never taken against. Whoever runs this cell uses this identity
    rather than resolving one afresh, which is what keeps the two from ever
    disagreeing about which kernel this place belongs to.
    """

    def __init__(self, turn: Turn, identity: KernelIdentity) -> None:
        self.turn = turn
        self.identity = identity

    def left(self) -> None:
        """Given up by a cell that is not going to run after all.

        A place nothing gives back is a kernel that never runs another cell,
        so whatever takes one ends by doing this however the cell turned out.
        A place its own cell already took is no longer in the queue, and this
        finds nothing to give back.
        """
        self.turn.leave(self)


class Turn:
    """One kernel's cells, run one at a time in the order they arrived.

    A namespace is one thing, and two cells running in it at once are two
    halves of two cells. A cell arriving while another runs waits; `depth`
    is how many are waiting behind the one that is running.
    """

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._waiting: deque[Place] = deque()
        self._running = False

    @property
    def depth(self) -> int:
        with self._condition:
            return len(self._waiting)

    @property
    def running(self) -> bool:
        with self._condition:
            return self._running

    def place(self, identity: KernelIdentity) -> Place:
        """A place at the back of this queue, taken now and waited on later.

        Nothing here waits, so whatever is reading cells off a stream can
        take each one's place as it reads it and go on reading. Carries the
        identity this turn was reached under, so whoever waits on it later
        does not have to resolve one of its own — see `Place`.
        """
        place = Place(self, identity)
        with self._condition:
            self._waiting.append(place)
        return place

    def leave(self, place: Place) -> None:
        """A place given back by a cell that will not be run.

        Whoever is behind it has been waiting for something that is not
        coming, so they are woken to find themselves further forward.
        """
        with self._condition:
            if place in self._waiting:
                self._waiting.remove(place)
                self._condition.notify_all()

    @contextmanager
    def taken(self, place: Place | None, identity: KernelIdentity) -> Iterator[None]:
        # `identity` is what a fresh place is minted for when the caller did
        # not already hold one — read the same way `execute` and `restart`
        # already have it, never resolved here. A `place` already given is
        # trusted as its own identity, carried since it was taken; this
        # parameter is not consulted for it.
        held = self.place(identity) if place is None else place
        with self._condition:
            # Its own place at the front, and not merely any place: a lock
            # alone would hand the kernel to whichever cell the platform
            # happened to wake, and a notebook read back in that order is
            # not the notebook that was run.
            while self._running or self._waiting[0] is not held:
                self._condition.wait()
            self._waiting.popleft()
            self._running = True
        try:
            yield
        finally:
            with self._condition:
                self._running = False
                self._condition.notify_all()


@dataclass(frozen=True)
class Environment:
    """One environment a kernel can be started in, as the daemon rendered it.

    The interpreter and the boundary travel together because they are one
    decision: a boundary is written where the operating system will look,
    and where it looks is decided by which interpreter is being started.
    """

    language: str
    name: str
    interpreter: str
    prefix: tuple[str, ...]


@dataclass(frozen=True)
class Confinement:
    """The environments one session's kernels may be started in.

    Decided on the other side of the wire and arriving already assembled.
    Nothing in this process can build one, which is what keeps a kernel from
    ever being started outside a boundary.
    """

    environments: dict[tuple[str, str], Environment]
    # Which environment an unaddressed cell of each language runs in.
    defaults: dict[str, str]
    # Both absent on the one this host was constructed with, which describes
    # no Task and no directory: what the daemon supplies is drawn around one
    # Task's workspace, and what a constructor supplies is drawn around none.
    task_id: str | None = None
    workspace: str | None = None
    # What a connection has to hold in order to be this session's own. Minted
    # by the daemon, which is also what writes it into the arguments of the
    # relay it starts — so naming this session and being the thing that was
    # given it are two different claims. Absent for a session nothing minted
    # one for, which reaches no kernels at all.
    token: str | None = None
    # Every name this lab has declared, whether or not this machine has built
    # any of them — which is what tells "your colleague declared this and you
    # have not built it here" apart from "this lab has no such environment".
    # `environments` above is the other half of that pair: what this machine
    # actually holds.
    #
    # Three-valued on purpose, and `None` is not `frozenset()`. An empty set
    # is an answer — the lab declared nothing. `None` is the absence of one:
    # the daemon's own ask for the declaration list failed, so nothing in
    # this process knows what the lab has declared, and the session was
    # configured anyway rather than left without kernels over a lab blip.
    declared: frozenset[str] | None = None

    def environment_for(self, language: str, name: str) -> Environment | None:
        return self.environments.get((language, name))

    def default_for(self, language: str) -> str | None:
        # Absent rather than "": a language nobody named a default for and a
        # default someone genuinely named the empty string are different
        # facts, and `environment_for`'s own absence is already `None` — a
        # sentinel `""` here is the one this pair's neighbour does not use.
        return self.defaults.get(language)


def _environments_from(entries: Any) -> tuple[dict[tuple[str, str], Environment], dict[str, str]]:
    """One entry per environment a session's kernels may start in, and which
    of them an unaddressed cell of each language runs in.

    The one place this shape is parsed, whether it arrived over the wire or
    from a caller standing in for it directly — `configure_session` is
    reachable either way, and a `Confinement` this process builds from an
    unvalidated entry is the one thing nothing here may ever hold. Anything
    this process cannot concatenate an interpreter onto is refused here
    rather than where a kernel would fail to start.
    """
    if not isinstance(entries, list):
        raise ValueError("a confinement is a list of environments")
    built: dict[tuple[str, str], Environment] = {}
    defaults: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("a confinement is a list of environments")
        language, name = entry.get("language"), entry.get("name")
        interpreter, prefix = entry.get("interpreter"), entry.get("prefix")
        if (
            not isinstance(language, str) or not isinstance(name, str)
            # Absolute, and not merely a string. A kernel's `PATH` is built by
            # making its interpreter absolute, which for a relative path means
            # joining it against THIS HOST's working directory — so a relative
            # interpreter would put a directory of the host's choosing in
            # front of every cell's `PATH`, while `/usr/bin/env` separately
            # resolved the program itself through the child's own. Refused
            # here, where every other malformed field already is.
            or not isinstance(interpreter, str) or not os.path.isabs(interpreter)
            or not isinstance(prefix, list)
            or not all(isinstance(part, str) for part in prefix)
        ):
            raise ValueError("a confinement is a list of environments")
        built[(language, name)] = Environment(
            language=language, name=name, interpreter=interpreter, prefix=tuple(prefix),
        )
        if entry.get("default"):
            # At most one per language — a second one is not a later
            # correction of the first, since nothing here can tell which of
            # two conflicting answers was meant, and a last-write-wins
            # accident is a session's kernels landing wherever it happened
            # to be sorted rather than where it was asked to be.
            if language in defaults:
                raise ValueError("a confinement is a list of environments")
            defaults[language] = name
    return built, defaults


def _declared_from(names: Any) -> frozenset[str] | None:
    """Every name the lab has declared, or nothing where nobody said.

    `None` in, `None` out — the caller was told nothing and this refuses to
    invent an answer for it. An empty list is not that: it is the lab saying
    it has declared nothing, and it becomes an empty set, which the refusals
    read differently.

    Validated here for the same reason `_environments_from` is: this is
    reachable without the wire, so what a `Confinement` may hold is decided
    here rather than trusted from whoever called.
    """
    if names is None:
        return None
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        raise ValueError("a declaration list is a list of names")
    return frozenset(names)


@dataclass
class Entry:
    """One identity, and whatever is behind it at the moment."""

    identity: KernelIdentity
    turn: Turn = field(default_factory=Turn)
    kernel: Kernel | None = None
    incarnation: int = 0
    execution_count: int = 0
    started_ts: int | None = None
    last_activity_ts: int | None = None
    # Whether this machine ended the process on purpose. A kernel that was
    # stopped and a kernel that died are different facts, and the second is
    # never reported as the first.
    stopped: bool = False
    # Written before the process is killed, and read by `execute` when the
    # stream it was reading is abandoned. This is the only thing that tells a
    # kernel somebody ended from a kernel that died: on the pipe the two are
    # the same event.
    #
    # Kept apart from `stop_reason`, which can be absent even when this is
    # true: a stop is what somebody chose, and choosing it is not the same
    # fact as having something to say about it. Keying the discriminator on
    # the reason being non-`None` would report a kernel stopped with nothing
    # said as a crash — a stop with nothing said is still a stop.
    #
    # Also the latch `stop()` reads back once its kill returns, the way
    # `reclaim_requested` is for `reclaim()`: `_replace` clears it the instant
    # a relaunch reaches this entry, and finding it cleared is how `stop()`
    # learns that the kernel it is about to write an ending over is a live one
    # somebody else started while the escalation ladder was running.
    stop_requested: bool = False
    stop_reason: str | None = None
    stopped_by: str | None = None
    # Why the process CURRENTLY behind this identity was started, when
    # something other than a cell arriving started it — today, an environment
    # rebuilt underneath it. Written by `_replace`, which is the one place a
    # process is ever put here, so it always describes the incarnation that is
    # actually running rather than some earlier one.
    #
    # This is the field that makes a reason survive a restart at all.
    # `stop_reason` cannot: it is written before the kill and cleared by the
    # relaunch that follows it, so the only thing that ever reads one is a
    # cell that was in flight at that instant. A kernel that was IDLE when its
    # environment was rebuilt — which is the state the asking agent's own
    # kernel is most likely to be in, minutes after it was told a build was
    # running — would otherwise come back with an empty namespace and no
    # sentence anywhere saying why.
    #
    # `None` and not `""` for a relaunch nobody gave a reason for: a lazy
    # relaunch after a crash, a researcher's own Restart. Absent is the honest
    # fact, the same rule `stop_reason` follows.
    restart_reason: str | None = None
    # Where an install inside a cell lands for the process CURRENTLY behind
    # this identity. Written by `_replace`, which is the one place a process
    # is ever put here, so it names the incarnation actually running rather
    # than one that has already been taken away — and `overlay_for` removes
    # the previous incarnation's directory as it makes this one, which is
    # what makes an inline install not survive a restart.
    #
    # `None` for a kernel whose session was confined without a workspace, and
    # for every language that has no such notion. `snapshot` answers a `None`
    # with nothing rather than raising, so a cell in one of those runs
    # normally and reports installing nothing.
    overlay: str | None = None
    # Set when this machine's own pressure policy took the kernel back,
    # rather than a researcher stopping it or its process crashing. A third
    # ending, kept apart from `stopped`: the sentence a researcher typed
    # belongs to a choice they made, and a kernel this machine took back on
    # its own must never be reported as one they ended, nor the reverse.
    reclaimed_ts: int | None = None
    # Written under the same locked block that drops `kernel` in `reclaim()`,
    # before the kill that can hold that window open for seconds, unlocked —
    # long enough for a cell to arrive and relaunch through `_replace` before
    # `reclaim()`'s own post-kill write would otherwise land. Cleared by
    # `_replace` alongside `reclaimed_ts`, so a relaunch that wins the race
    # leaves nothing here for that post-kill write to find still set. What it
    # guards: a live, freshly relaunched kernel must never be stamped
    # `reclaimed_ts` nor have the probe reading it was just given nulled out
    # from under it.
    reclaim_requested: bool = False
    # The handle this entry's process is read through, and the newest reading
    # taken with it. Both belong to one incarnation: the probe is dropped when
    # the process is, because a handle carried across a restart would report
    # the dead process's average as the new one's first sample.
    probe: Probe | None = None
    latest: Sample = field(default_factory=Sample)
    # Sixteen seconds of history at a two-second tick, against a screen that
    # polls every four: every poll carries roughly two new readings and six
    # the browser has already seen, which is what lets a sparkline stay
    # continuous across a refresh or a second researcher opening the screen.
    ring: deque[Sample] = field(default_factory=lambda: deque(maxlen=RING))


class Registry:
    """Every kernel this host holds, and the one way to run a cell in one."""

    def __init__(
        self,
        prefix: list[str],
        *,
        interpreter: str = sys.executable,
    ) -> None:
        # Resolved once, here, because asking per session would put a
        # subprocess on the path of every turn.
        self._runnables = runnables(interpreter)
        self._by_language = {runnable.language: runnable for runnable in self._runnables}
        # What a session this host was told nothing about falls back to. A
        # host is constructed before any session exists and `serve()` passes
        # no prefix at all, so the fallback starts nothing until a daemon has
        # said what a boundary is — one entry per language this machine can
        # run, all behind the constructor's own prefix, because that prefix
        # describes no particular session's boundary to draw them apart by.
        self._unconfigured = Confinement(
            environments={
                (runnable.language, runnable.environment): Environment(
                    language=runnable.language,
                    name=runnable.environment,
                    interpreter=runnable.interpreter,
                    prefix=tuple(prefix),
                )
                for runnable in self._runnables
            },
            defaults={runnable.language: runnable.environment for runnable in self._runnables},
        )
        self._sessions: dict[str, Confinement] = {}
        self._entries: dict[str, Entry] = {}
        self._lock = threading.Lock()
        # Where a cell goes once it has run, assigned by whatever holds the
        # stream the lab is reached over. A registry nobody has connected
        # still runs cells: a cell that ran is a fact whether or not
        # anything is listening for it.
        self.on_cell: Callable[[dict[str, Any]], None] | None = None
        # How this host asks the daemon for something only the daemon can
        # do — raise a permission card, call the lab with the researcher's
        # own token. Assigned by whatever holds that stream, and `None` on a
        # registry nobody connected, which every unit test that builds one
        # directly leaves it as. Unset is a real state and not a defensive
        # one: whoever reaches for this says so out loud rather than
        # answering a fake success.
        self.ask_daemon: Callable[[str, dict[str, Any]], Any] | None = None

    @property
    def runnables(self) -> tuple[Runnable, ...]:
        """Every language this host can start a kernel in, as the greeting
        reports them."""
        return self._runnables

    def configure_session(
        self,
        *,
        session_id: str,
        task_id: str,
        workspace: str | None,
        environments: list[dict[str, Any]],
        token: str | None = None,
        declared: list[str] | None = None,
    ) -> None:
        """The boundary this session's kernels are to be started inside.

        A later call replaces what an earlier one said, because a session
        whose environments or workspace changed is a session whose kernels
        have to be started differently — and what is already running was
        started inside the boundary it was given, which a restart is how a
        researcher asks to leave.

        One entry per environment this session's kernels may start in, the
        same shape a caller standing in for the daemon hands over on the
        wire: a language, a name, the interpreter, and the prefix in front of
        it, with at most one per language marked `default` for a cell that
        names none. Validated here rather than trusted, because this method
        is reachable directly and not only from the wire's own parsing —
        `_environments_from` is the one place that shape is checked, so
        nothing that calls this can hold a `Confinement` neither of them
        agreed to.

        `declared` is what the lab says exists, which is a different list
        from the one above: an environment can be declared lab-wide and not
        built here, and a cell naming one is owed a different sentence than a
        cell naming a name nothing anywhere has heard of. Omitted entirely by
        a caller whose own ask for that list failed — a session is still
        configured on one of those, because a lab too slow to answer must not
        be a machine that starts no kernels.
        """
        built, defaults = _environments_from(environments)
        names = _declared_from(declared)
        with self._lock:
            self._sessions[session_id] = Confinement(
                environments=built,
                defaults=defaults,
                task_id=task_id,
                workspace=workspace,
                token=token,
                declared=names,
            )
        # What bounds the overlays of a host that DIED. `release_session` is
        # the tidy path and it cannot run for a process that was killed, so
        # the disk of every kernel that process held would otherwise sit under
        # this Task forever — and a kernel's id digests its session, so a Task
        # worked on across twenty sessions would hold twenty full trees. A new
        # host holds no entries at all, which makes every tree here unheld,
        # which is exactly the sweep this wants.
        #
        # `_claim_unheld` is where the deciding and the removing happen, and
        # they happen as one step under the mutex a cell files its kernel
        # under — see it, and `sweep_overlays`, for the race that shape
        # closes. What is left out here is the deleting, which `sweep_overlays`
        # does afterwards holding nothing: two sessions can share one Task, so
        # a cell of one really can be starting a kernel while the other is
        # being configured, and a registry-wide lock held across an `rmtree` of
        # a scientific stack would stop that cell for as long as it took.
        if workspace is not None:
            sweep_overlays(workspace, self._claim_unheld)

    def identity_for(
        self,
        session_id: str,
        task_id: str,
        name: str,
        language: str,
        environment: str | None,
    ) -> KernelIdentity:
        """One identity, resolved against this session's confinement as it
        stands right now.

        This is the only place a default is applied, but it is not the only
        place resolved for one cell needs the answer to agree with itself:
        both the thread that takes a cell's place in the queue and the
        thread that later runs it need the identity, and `kernel_id_for` is
        a digest of it, so two calls made at two different moments can
        genuinely disagree if the session was reconfigured in between —
        this method reads live state and has no memory of its own answer.
        What keeps that from minting two kernels for one cell is not this
        method resolving only once; it is every caller resolving once and
        carrying the answer forward — `Place.identity` is where it is kept
        between the two.
        """
        self._runnable_for(language)
        confinement = self._confinement_for(session_id)
        named = environment if environment else confinement.default_for(language)
        if named is None:
            raise ValueError(f"this session has no {language} environment")
        if confinement.environment_for(language, named) is None:
            # Three absences, three sentences. A name this machine cannot
            # start a kernel in is one fact; which of the three reasons it
            # is decides what a researcher is told to do about it, and the
            # wrong one of them tells them their colleague's environment
            # does not exist.
            if confinement.declared is None:
                # Nothing here knows what this lab has declared -- this
                # session was configured on a cycle whose ask for the
                # declaration list failed. The machine-scoped sentence is
                # the only one true under both absences.
                raise ValueError(
                    f"this machine has no {language} environment named {named}"
                )
            if named in confinement.declared:
                raise ValueError(
                    f"the environment {named} is not built on this machine yet"
                )
            raise ValueError(f"this lab has no environment named {named}")
        return KernelIdentity(
            session_id=session_id, task_id=task_id, name=name,
            language=language, environment=named,
        )

    def default_environment_for(self, session_id: str, language: str) -> str | None:
        """Which environment a cell of this language that names none runs in.

        The same `Confinement.default_for` `identity_for` resolves an
        unaddressed cell through, read against the same confinement — so a
        tool that says "this session's own environment" and a cell that names
        none cannot come to mean two different places. `None` where this
        session has no default for that language at all, which `identity_for`
        already refuses by name.
        """
        return self._confinement_for(session_id).default_for(language)

    def confinement_for(self, session_id: str) -> Confinement | None:
        """What this host was told about one session, or nothing for a session
        it was told nothing about.

        Distinct from the fallback `execute` runs against: a caller asking
        this is asking whether the session exists here at all, and the answer
        for one that does not is "no" rather than the boundary a session this
        host was never told about would be started inside.
        """
        with self._lock:
            return self._sessions.get(session_id)

    def arriving(self, identity: KernelIdentity) -> Place:
        """This cell's place in its kernel's queue, taken where it arrived.

        For whatever is reading cells off a stream to call as it reads them,
        so that a kernel runs them in the order they were sent rather than in
        the order the threads carrying them happen to be scheduled. Nothing
        here waits on the cell in front, so the stream goes on being read.
        """
        self._runnable_for(identity.language)
        return self._entry_for(kernel_id_for(identity), identity).turn.place(identity)

    def execute(
        self,
        identity: KernelIdentity,
        source: str,
        *,
        origin: dict[str, str],
        tool_use_id: str | None = None,
        place: Place | None = None,
    ) -> dict[str, Any]:
        """One cell, and the record of it the lab keeps.

        A cell whose place was already taken by whoever received it waits on
        that place; one that arrives here without a place takes it now.
        """
        self._runnable_for(identity.language)
        kernel_id = kernel_id_for(identity)
        entry = self._entry_for(kernel_id, identity)
        with entry.turn.taken(place, identity):
            kernel = self._running(entry)
            # Read after `_running`, never before it: a lazy relaunch happens
            # inside that call and gives this entry a NEW overlay, so a path
            # read first would be the dead incarnation's — already removed,
            # and every package the cell then installs reported as nothing.
            #
            # The whole notice is these two listings. Nothing reads the cell's
            # source, because a source that says how it installed something is
            # a source that could have said it any other way.
            overlay = entry.overlay
            before = snapshot(overlay)
            began = time.monotonic()
            try:
                result = kernel.execute(source)
            except RuntimeError:
                # A kernel somebody ended and a kernel that fell over abandon
                # this stream identically, and both raise from here. Whether a
                # stop was requested on the entry is the only thing that tells
                # them apart — not whether a reason was given, since a stop
                # with nothing said is still a stop.
                if not entry.stop_requested:
                    # Nobody chose this. The crash path is unchanged, and the
                    # caller is owed the error it has always been given.
                    raise
                result = _stopped_cell(entry.stop_reason, entry.stopped_by, entry.execution_count)
                # Under the lock, like every other write to this field:
                # `stop()` and `_replace` both write it inside `self._lock`,
                # and a lock only one side takes excludes nothing. Nothing
                # here needs the read and the clear to be one step — the read
                # above already happened — but a field written under a mutex
                # in three places and free of it in a fourth is a rule that
                # holds only until somebody reads the fourth and copies it.
                with self._lock:
                    entry.stop_reason = None
            wall_ms = int((time.monotonic() - began) * 1000)
            # Taken while the turn is still held, so nothing another cell
            # installed can be attributed to this one — and taken on both
            # paths, including the one where the kernel was stopped mid-cell:
            # a cell that installed something and was then ended still
            # installed it, and a researcher reading that cell back is owed
            # the same answer as on any other.
            installed = installed_between(before, snapshot(overlay))
            # This cell's own counter, kept while the kernel is still held:
            # the entry's is what the next cell will overwrite, and a cell
            # that reported its successor's number would be a notebook
            # nobody can read back.
            count = int(result.get("execution_count", 0))
            entry.execution_count = count
            entry.last_activity_ts = int(time.time())

        cell: dict[str, Any] = {
            "kernelId": kernel_id,
            # Carried so whoever receives the `cell` notification can tell
            # which session and Task ran it without inverting `kernelId`'s
            # own digest back into the identity that produced it — the
            # notification otherwise names no session or Task at all.
            "sessionId": identity.session_id,
            "taskId": identity.task_id,
            "name": identity.name,
            "language": identity.language,
            "environment": identity.environment,
            "executionCount": count,
            "source": source,
            "origin": {"surface": origin["surface"], "by": origin["by"]},
            "ok": bool(result.get("ok", False)),
            "wallMs": wall_ms,
            "ts": int(time.time()),
            "outputs": list(result.get("outputs", [])),
        }
        # What this cell installed into THIS kernel and nowhere else, absent
        # rather than empty on the cell that installed nothing. `[]` here
        # would put the key on every row of every notebook in this lab, and
        # any reader that showed the field where it was present would then
        # show it everywhere — which is the whole distinction the field
        # exists to carry.
        if installed:
            cell["installed"] = installed
        if tool_use_id is not None:
            cell["toolUseId"] = tool_use_id
        if self.on_cell is not None:
            self.on_cell(cell)
        return cell

    def interrupt(self, kernel_id: str) -> None:
        """Ends the cell running in this kernel, and leaves the kernel up.

        Asked of the kernel without checking first whether it has a cell in
        it: a cell can finish inside the gap such a check would open, and
        each language's kernel knows better than this does what a signal
        would mean to it just then. A Python kernel is deaf to one except for
        the length of a cell, by its own arrangement, so a late interrupt is
        delivered nowhere at all. An R kernel cannot be deaf — base R has no
        `signal()` to be deaf with — so its host holds the signal instead,
        sending only between the driver's own `run` record and the terminator
        that answers it, and its driver answers every cell it began whatever
        reaches it.
        """
        entry = self._known(kernel_id)
        if entry.kernel is not None:
            entry.kernel.interrupt()

    def stop(self, kernel_id: str, *, feedback: str | None = None, by: str | None = None) -> None:
        """Ends this kernel, and tells whatever cell was in it why.

        The reason is written before anything is killed. A cell in flight is
        about to lose its stream, and the only way `execute` can tell that
        from an interpreter that fell over is to find a reason waiting for it.
        Written under the lock, the same way `sample()` snapshots before doing
        its own work outside it: a lazy relaunch racing this write is what
        would turn a chosen stop into a reported crash, on a window otherwise
        left to chance.

        The process is dropped along with the handle, rather than left dead
        behind the entry the way a crash leaves one. `_running` refuses a dead
        kernel because a crash took a namespace nobody chose to lose; a stop
        is chosen and announced, so the researcher already knows the namespace
        went and the next cell is owed a process rather than a refusal.

        A cell already queued behind this kernel is owed that same fresh
        process, today, whether or not it was authored knowing the namespace
        would go — it is not told the kernel it was queued for is gone, and
        can succeed in the new, empty namespace with a plausible wrong answer
        rather than raising. Known wrong, and deferred to its own task.
        """
        entry = self._known(kernel_id)
        with self._lock:
            entry.stop_requested = True
            entry.stop_reason = feedback
            entry.stopped_by = by
            kernel = entry.kernel
            entry.kernel = None
        # The kill itself is done outside the lock: a kernel's `stop()` has an
        # escalation ladder that can take seconds, and holding the lock across
        # it would block `list()` and every other reader for as long as that
        # takes.
        if kernel is not None:
            kernel.stop()
        # Locked, the same mutex the first three fields above were written
        # under and the same one `_replace`'s clearing block takes: `_replace`
        # writes `entry.stopped = False` as one of its own four fields inside
        # `self._lock`, and an unlocked write here could still land between
        # that block's individual assignments — landing after `stopped` is
        # cleared but before the other three are — leaving `stopped` true
        # while `stop_requested`, `stop_reason`, and `stopped_by` all read
        # cleared. A lock only one side takes excludes nothing, which is what
        # closing it on three fields and leaving it open on the fourth would
        # still be.
        #
        # And keyed on the latch the same way `reclaim()`'s post-kill block
        # is, for the same reason and against a wider window: the ladder above
        # spends a second per rung, and its `join` does not return early while
        # the cell's own forked workers still hold the pipe — which is exactly
        # the workload a researcher reaches for Stop over. The in-flight cell
        # raises the moment the process dies and a queued one relaunches
        # through `_replace` inside that second, so by the time the kill
        # returns this entry can already hold a live process somebody else
        # started. Writing `stopped` over it would report a running kernel as
        # ended — permanently, since `stopped` is the first branch `_state`
        # asks and `_replace` only runs for an entry holding no kernel — and
        # nulling the probe would hide that live process from the sampler and
        # from the pressure policy for the rest of its life. Cleared means a
        # relaunch already claimed this entry: none of the five writes below
        # belong to it, not one of them, since a half-applied ending is still
        # an ending reported over a kernel that has not had one.
        with self._lock:
            still_this_incarnation = entry.stop_requested
            if still_this_incarnation:
                entry.stopped = True
                entry.probe = None
        if still_this_incarnation:
            entry.latest = Sample()
            entry.ring.clear()

    def reclaim(
        self,
        *,
        total_memory: int,
        holding: int,
        share: float = DEFAULT_SHARE,
        now: int | None = None,
    ) -> str | None:
        """Takes back the least-recently-used idle kernel, if this machine is
        over its ceiling. Returns which, or `None`.

        One per pass, deliberately. Resident memory does not return the
        instant a process dies, so a batch chosen from a single reading
        over-reclaims — three kernels taken to get under a line that one
        would have cleared. The next tick tells the truth.

        `share >= 1.0` is a researcher saying take nothing, ever, and is
        answered before a single figure is read. `running` is never a
        candidate — killing live work to save memory is the one thing Stop
        exists to make deliberate, and the policy must not reintroduce it
        through a side door — nor is anything idle for less than
        `IDLE_FLOOR_S`, which is what keeps a researcher alternating between
        two Tasks from having whichever they just left taken, repeatedly.
        """
        if share >= 1.0 or total_memory <= 0:
            return None
        if holding <= total_memory * share:
            return None
        when = int(time.time()) if now is None else now
        with self._lock:
            candidates = [
                (kernel_id, entry)
                for kernel_id, entry in self._entries.items()
                # `idle` only. `running` is working; the rest hold no process.
                if self._state(entry) == "idle"
                and when - (entry.last_activity_ts or entry.started_ts or when) >= IDLE_FLOOR_S
            ]
            if not candidates:
                return None
            kernel_id, entry = min(
                candidates,
                key=lambda pair: pair[1].last_activity_ts or pair[1].started_ts or 0,
            )
            # The handle snapshot goes under the lock, the same as `stop()`'s
            # does: dropped here rather than left dead behind the entry, so
            # `_running` finds a lazy entry at the next cell and relaunches
            # through `_replace` instead of raising "this kernel crashed" —
            # a researcher did not choose this ending, but the next cell is
            # still owed a process rather than a refusal.
            kernel = entry.kernel
            entry.kernel = None
            # Set here, under the same lock the drop above just happened
            # under, and read back below once the kill has returned. `_replace`
            # clears it, under its own locked block, the instant a relaunch
            # reaches that entry — which the escalation ladder below gives it
            # seconds to do, unlocked. A lock around the post-kill write alone
            # closes only that write being torn; it does not stop the write
            # from happening at all, which is what this flag is for.
            entry.reclaim_requested = True
        # The kill itself is done outside the lock, the same reason `stop()`'s
        # is: a kernel's `stop()` has an escalation ladder that can take
        # seconds, and holding the lock across it would block `list()` and
        # every other reader for as long as that takes. It is exactly this
        # window — unlocked and seconds long — that a cell can arrive in and
        # relaunch this same entry through `_replace` before the block below
        # ever runs.
        if kernel is not None:
            kernel.stop()
        # Locked, the same mutex `_replace`'s clearing block writes
        # `reclaimed_ts = None` and `reclaim_requested = False` under. The
        # lock makes this write atomic; it does not make it correct on its
        # own — a relaunch fully finishing, under its own lock uses, while
        # this thread was parked inside `kernel.stop()` above is not torn,
        # it is just a fact this thread has not read yet, and reading
        # `reclaim_requested` is how it catches up: still set means nothing
        # claimed this entry in between, and the stamp belongs to the
        # process that was just killed; cleared means a relaunch already
        # gave the entry a live process, and stamping over it here would
        # mislabel that process `reclaimed` and blind the sampler to it by
        # nulling the probe it was just given.
        with self._lock:
            still_this_incarnation = entry.reclaim_requested
            if still_this_incarnation:
                entry.reclaimed_ts = when
                entry.probe = None
        if still_this_incarnation:
            entry.latest = Sample()
            entry.ring.clear()
        return kernel_id

    def restart(
        self,
        kernel_id: str,
        *,
        reason: str | None = None,
        end_running_cell: bool = False,
    ) -> dict[str, Any]:
        """A new process behind the same name, and the kernel as it now is.

        Everything the process it replaces was holding goes with it, which
        is what a researcher asking for a restart is asking for.

        **Two independent axes, and they must stay independent.** `reason` is
        a SENTENCE — why this happened, carried onto the new incarnation so
        something can say it afterwards. `end_running_cell` is CONTROL FLOW —
        whether the cell in front is waited for or ended. Tying the second to
        the first is how a rebuild-restart that nobody wrote a sentence for
        ends up waiting, politely and unboundedly, behind a cell whose
        interpreter has already been deleted.

        `end_running_cell=False`, the default, is a researcher's own Restart
        click: it takes its turn like a cell does, so it waits for the one in
        front rather than pulling a namespace out from under a cell halfway
        through writing to it — and so two restarts arriving together leave
        one process behind rather than two. There is real work in front of it
        and that work's ground is intact. Ending a cell is what an interrupt
        is for.

        `end_running_cell=True` is a restart this machine is IMPOSING, and the
        only thing that imposes one is `restart_environment` after a rebuild.
        `materializeEnvironment` has run `uv venv --clear` by then, so the
        cell in front is running on an interpreter that no longer exists:
        waiting for it is waiting behind doomed work, and its "success" is a
        result nobody should trust. So the ending is announced first, through
        `stop` — which is what puts `reason` where a cell that loses its
        stream will find it, rather than reading its own kernel as having
        crashed — and then a process is given back.
        """
        entry = self._known(kernel_id)
        if end_running_cell:
            # Announced before it is taken, the way every chosen ending in
            # this file is: `stop` writes the reason before it kills, so the
            # cell that loses its stream finds a sentence waiting.
            self.stop(kernel_id, feedback=reason)
        with entry.turn.taken(None, entry.identity):
            self._replace(entry, reason)
        return self._described(kernel_id, entry)

    def restart_environment(self, name: str, reason: str | None = None) -> list[str]:
        """Restarts every kernel started in `name`, and says which.

        Called when this machine has just rebuilt that environment. It is
        CORRECTNESS, not courtesy: `materializeEnvironment` runs `uv venv
        --clear`, which removes everything already at the target path — so a
        kernel still running against a rebuilt environment is a process whose
        interpreter and site-packages have been deleted out from under it.
        It will go on answering out of whatever it already imported and fail
        the moment it needs the disk, which reads to a researcher as their
        own code breaking for no reason.

        By the environment a kernel's IDENTITY names, which is the same field
        `kernel_id_for` digests and `_replace` resolves a boundary from —
        never by what a session's default happens to be right now, since two
        kernels of one session can sit in two different environments and only
        one of them was rebuilt.

        An environment nothing is bound to is not an error. A machine that
        built something no session has run a cell in yet is the ordinary case
        — an empty list is the honest answer, not a refusal.

        **Never waits, reason or no reason.** Every one of these ends the cell
        in front of it, because by the time this is called that cell's
        interpreter has already been deleted — see `restart`'s
        `end_running_cell`. Whether anybody wrote a sentence about the rebuild
        has nothing to do with it: a Setup click carries no reason and clears
        the same directory.
        """
        with self._lock:
            bound = [
                kernel_id
                for kernel_id, entry in self._entries.items()
                if entry.identity.environment == name
            ]
        # `reason` travels as it was given, not dressed up as "restarted
        # because …": the sentence describes the process that ENDED, and this
        # end cannot promise a relaunch it has not performed yet. What the
        # ending owes the researcher is why their namespace went, and that is
        # exactly what `reason` says. Empty is not a sentence, and is read as
        # nobody having said anything rather than passed on as one.
        said = reason or None
        restarted: list[str] = []
        for kernel_id in bound:
            # `restart` reads the entry again for itself, so one forgotten
            # between the snapshot above and here — a session released
            # mid-rebuild — is skipped rather than raised over. The rest of
            # this machine's kernels still have to be put back.
            try:
                self.restart(kernel_id, reason=said, end_running_cell=True)
            except ValueError:
                continue
            restarted.append(kernel_id)
        return restarted

    def list(self) -> list[dict[str, Any]]:
        """One entry per identity this host knows, whether or not a process
        is behind it."""
        with self._lock:
            known = list(self._entries.items())
        return [self._described(kernel_id, entry) for kernel_id, entry in known]

    def environments_for(self, session_id: str) -> dict[str, Any]:
        """Every environment name one session can reach, and which of them
        this machine has actually built.

        Both halves of one question, and this host already holds both: a
        confinement's `environments` are what this machine built, and its
        `declared` is every name the lab said exists. Nothing here has to ask
        the lab, which is why an agent can be told this without a round trip.

        Three-valued, like the refusals it is the other face of.
        `declared is None` is a lab that was never successfully asked — the
        cycle that configured this session had its own ask for the
        declaration list fail — and it is reported as `declarationsKnown:
        false` rather than as a lab that declared nothing. The rows are then
        everything this machine has built and no claim at all about what else
        exists, which is the whole of what is true. A lab that genuinely
        declared nothing has the same rows and says so: the two differ
        nowhere else, so collapsing them would lose the distinction entirely.

        Each row also says whether this session's kernels in that environment
        were last started by something other than a cell, and why — which for
        this phase means an environment rebuilt underneath them. That is the
        one thing an AGENT can observe about a rebuild it asked for:
        `manage_packages` answers before the build finishes, deliberately, so
        the model needs somewhere to look to find out that it has. A row
        naming a reason is that build having landed and this Task's kernels in
        it having been restarted; a row naming none is a build that has not
        landed yet, or one nobody wrote a sentence about.

        The lock is taken only to snapshot the confinement, the way `list`
        takes it only to snapshot its entries — an answer is built outside it,
        where nothing a cell needs is waiting.
        """
        # The same confinement `execute` would run a cell against, fallback
        # and all: what this answers about a session and where that session's
        # cells actually land have to be the same boundary, or the list is a
        # description of some other machine.
        confinement = self._confinement_for(session_id)
        # Snapshotted under the same lock, and only to read: one reason per
        # environment name, from this session's own kernels. Two kernels of
        # one session in one environment are restarted by the same rebuild
        # with the same sentence, so which of them answers is not a choice
        # anything has to make.
        with self._lock:
            restarts = {
                entry.identity.environment: entry.restart_reason
                for entry in self._entries.values()
                if entry.identity.session_id == session_id and entry.restart_reason is not None
            }
        rows: list[dict[str, Any]] = [
            {
                "name": name,
                "language": language,
                "builtHere": True,
                # Absent, never null or empty: a kernel nobody restarted and a
                # restart nobody explained are both "nothing to say", and a
                # key holding an empty sentence would read as one.
                **({} if name not in restarts else {"restartedBecause": restarts[name]}),
            }
            for language, name in confinement.environments
        ]
        if confinement.declared is not None:
            # By name alone, because a declaration IS a name: the lab declares
            # environments, not (language, name) pairs, so a declared row
            # carries no language rather than a guessed one. D1 makes them all
            # Python today, and a language invented here would be the sort of
            # fact this file refuses to invent everywhere else.
            here = {name for _, name in confinement.environments}
            rows += [
                {"name": name, "builtHere": False}
                for name in confinement.declared - here
            ]
        # By name, so what an agent reads is in an order it can scan rather
        # than in whatever order a dict and a frozenset happened to hold.
        rows.sort(key=lambda row: (row["name"], row.get("language", "")))
        return {"environments": rows, "declarationsKnown": confinement.declared is not None}

    def sample(self) -> None:
        """Reads every live kernel's process once.

        The lock is taken only to snapshot which entries to read, never
        across the reads themselves: a sampler holding it would contend with
        a cell, and this figure is not worth a millisecond of a researcher's
        work.
        """
        with self._lock:
            entries = [entry for entry in self._entries.values() if entry.probe is not None]
        for entry in entries:
            entry.latest = entry.probe.sample()  # type: ignore[union-attr]
            entry.ring.append(entry.latest)

    def release_session(self, session_id: str) -> int:
        """Ends every kernel of a session and forgets them.

        Forgotten as well as ended, because a session that has closed is not
        coming back for its namespaces, and an identity nothing can address
        again is a kernel a machine would otherwise list forever.

        Its boundary goes with them. A session that closed and one that never
        opened reach the same distance, which is none.

        And what those kernels installed goes with them too. A kernel's id
        digests its session, so nothing will ever address these identities
        again — the packages under them are disk nothing can read, and left
        standing they are how a Task worked on across many sessions comes to
        hold many copies of a scientific stack under a dot-directory. The
        workspace is read off the confinement being dropped, because after
        this there is nothing left that knows where this session's Task was.
        """
        with self._lock:
            confinement = self._sessions.pop(session_id, None)
            going = [
                kernel_id
                for kernel_id, entry in self._entries.items()
                if entry.identity.session_id == session_id
            ]
            released = [self._entries.pop(kernel_id) for kernel_id in going]
        for entry in released:
            if entry.kernel is not None:
                entry.kernel.stop()
                entry.probe = None
                entry.latest = Sample()
        # After the kernels are stopped, never before: a process still running
        # against a directory that has been removed underneath it is a cell
        # failing on a path this host took away.
        workspace = None if confinement is None else confinement.workspace
        if workspace is not None:
            for kernel_id in going:
                drop_overlay(workspace, kernel_id)
        return len(released)

    def shutdown(self) -> None:
        """Ends every process this host holds, keeping what it held them for.

        A host stops when the daemon that started it does, and a kernel left
        running past that point is a process on a researcher's machine that
        nothing is holding the other end of.
        """
        with self._lock:
            known = list(self._entries.values())
        for entry in known:
            if entry.kernel is not None:
                entry.kernel.stop()
                entry.stopped = True
                entry.probe = None
                entry.latest = Sample()
                entry.ring.clear()

    def _claim_unheld(self, kernel_id: str, take: Callable[[], None]) -> None:
        """Takes one overlay tree away, if and only if no identity here owns it.

        **The deciding and the taking are one step, and this is the step.** Both
        happen inside a single hold of the mutex `_entry_for` files an entry
        under, so a cell cannot land between them: landing means filing an
        entry, filing one means taking this lock, and this lock is not free
        until the tree is already gone. Asked and answered separately — which
        is what this replaced — there is a window in which a cell files its
        kernel and `_replace` lays down a fresh overlay, and the removal then
        falls on a live kernel and takes the packages a cell just installed.
        Demonstrated, not theorised: `endpoint.py` gives every connection its
        own OS thread, so a tool call and a `configure_session` on the control
        channel genuinely run at once.

        `take` has to be cheap for that reason, and it is: it renames the tree
        out of reach rather than deleting it, and `sweep_overlays` deletes the
        bytes afterwards holding nothing. A lock kept across an `rmtree` of a
        scientific stack would stop every cell on this machine.

        Held is about the ENTRY, not about a live process: a lazy or stopped
        kernel still owns its overlay, since the next cell relaunches it under
        the same id, and a test keyed on `entry.kernel is not None` would take
        the packages out from under a kernel a researcher is coming back to.
        """
        with self._lock:
            if kernel_id in self._entries:
                return
            take()

    def _entry_for(self, kernel_id: str, identity: KernelIdentity) -> Entry:
        with self._lock:
            entry = self._entries.get(kernel_id)
            if entry is None:
                entry = Entry(identity=identity)
                self._entries[kernel_id] = entry
            return entry

    def _known(self, kernel_id: str) -> Entry:
        with self._lock:
            entry = self._entries.get(kernel_id)
        if entry is None:
            raise ValueError(f"this machine holds no kernel named {kernel_id}")
        return entry

    def _running(self, entry: Entry) -> Kernel:
        if entry.kernel is None:
            return self._replace(entry)
        if not entry.kernel.alive():
            # Not replaced underneath the cell that found it gone. A kernel
            # that died took a namespace with it, and a host that quietly
            # started another would answer out of an empty one and report
            # success — which reads as the researcher's own code being wrong.
            raise RuntimeError("this kernel crashed, and a restart is what gives it a new process")
        return entry.kernel

    def _confinement_for(self, session_id: str) -> Confinement:
        with self._lock:
            return self._sessions.get(session_id, self._unconfigured)

    def _runnable_for(self, language: str) -> Runnable:
        """What this machine would start a kernel of this language with.

        Refused here rather than at a launch that has already stopped whatever
        was running: a language this machine cannot run is not a kernel that
        starts late.
        """
        runnable = self._by_language.get(language)
        if runnable is None or language not in LAUNCHERS:
            raise ValueError(f"this machine holds no {language} kernels")
        return runnable

    def _replace(self, entry: Entry, reason: str | None = None) -> Kernel:
        # `reason` is why THIS process is being started, and it is recorded on
        # the entry rather than only handed to a cell — see
        # `Entry.restart_reason`. Defaulted to `None` because the caller that
        # does not pass one is a lazy relaunch, which is a kernel coming back
        # because somebody ran a cell in it and needs no explanation; that
        # `None` is also what CLEARS an earlier reason, so a kernel restarted
        # for a rebuild and then relaunched again does not go on reporting the
        # rebuild as the reason for a process it did not start.
        #
        # Resolved before anything is stopped and before anything is spawned:
        # a kernel that cannot be started is no reason to end the one already
        # running, and a refusal made here is one no argument list was ever
        # assembled for.
        confinement = self._confinement_for(entry.identity.session_id)
        # A boundary is drawn around one Task's directory. Another Task's
        # kernel started inside it would be handed that Task's work to write.
        if confinement.task_id is not None and confinement.task_id != entry.identity.task_id:
            raise ValueError(
                f"this session is confined for {confinement.task_id}, "
                f"and {entry.identity.task_id} is another Task's work"
            )
        environment = confinement.environment_for(
            entry.identity.language, entry.identity.environment
        )
        if environment is None or not environment.prefix:
            raise ValueError("no confinement was supplied for this kernel")
        if entry.kernel is not None:
            entry.kernel.stop()
        # The incarnation this is about to start, named before it starts:
        # `entry.incarnation` is raised further down, once there is a process
        # for it to be counting. Making the directory is also what removes
        # the previous incarnation's, which is where "an inline install does
        # not survive a restart" actually happens — the packages are gone
        # from the disk, not merely unreachable from a fresh namespace.
        #
        # Python only. The overlay is `PIP_TARGET` and a `PYTHONPATH`, and
        # neither means anything to R — see `launch_env`. And nothing at all
        # without a workspace: a confinement the daemon builds always carries
        # one, and a kernel that refused to start for want of somewhere to
        # put pip's output would make every kernel depend on a feature about
        # installing things.
        overlay = (
            overlay_for(
                confinement.workspace, kernel_id_for(entry.identity), entry.incarnation + 1
            )
            if confinement.workspace is not None and entry.identity.language == "python"
            else None
        )
        # Written before the launch rather than after it: a launch that
        # raises has already had the previous incarnation's overlay removed
        # underneath it, and an entry still naming that path would have the
        # next cell diffing a directory nothing is writing to.
        entry.overlay = overlay
        entry.kernel = LAUNCHERS[entry.identity.language](
            entry.identity,
            list(environment.prefix),
            environment.interpreter,
            confinement.workspace,
            # Composed against this host's own inheritance, which is the same
            # thing the launcher will lay it over: `environment_of` carries
            # `PYTHONPATH` through untouched and records why. If that ever
            # stops being true, the composition moves to wherever the swept
            # answer is, because what has to lead is the path the kernel
            # actually gets rather than the one this process was started with.
            None if overlay is None else launch_env(overlay, os.environ),
        )
        entry.probe = Probe(entry.kernel.pid)
        entry.latest = Sample()
        entry.ring.clear()
        entry.incarnation += 1
        entry.execution_count = 0
        entry.started_ts = int(time.time())
        entry.last_activity_ts = None
        # Assigned, never OR-ed with what was there: this describes the
        # process that has just started, so a relaunch nobody explained must
        # clear whatever explained its predecessor. Empty is nobody having
        # said anything, and is stored as absence rather than as a sentence
        # with no words in it.
        entry.restart_reason = reason or None
        # Locked, the same mutex `stop()` writes these under: a lazy relaunch
        # clearing `stop_requested` while `stop()` is mid-write to it is the
        # exact race that turns a chosen stop into a reported crash, and a
        # lock only one side takes excludes nothing.
        with self._lock:
            entry.stopped = False
            # Cleared with it. A reason left standing from one incarnation
            # would be found by the first abandoned cell of the next, and a
            # crash would be reported as a stop by somebody who ended a
            # process that no longer exists.
            entry.stop_requested = False
            entry.stop_reason = None
            entry.stopped_by = None
            # Cleared alongside them: a kernel this call just gave a fresh
            # process is not a kernel still reclaimed, and a `reclaimed_ts`
            # left standing would have the next incarnation reporting the
            # ending of the one it replaced.
            entry.reclaimed_ts = None
            # Cleared here too, and for the same reason `reclaimed_ts` is: a
            # `reclaim()` call already past its own kill, parked on this same
            # lock, reads this flag once it gets back in to decide whether to
            # stamp `reclaimed_ts`/null `probe` at all. This relaunch just
            # gave the entry a live process — clearing the flag it would
            # otherwise still find set is what tells that `reclaim()` call to
            # leave this incarnation alone.
            entry.reclaim_requested = False
        return entry.kernel

    def _described(self, kernel_id: str, entry: Entry) -> dict[str, Any]:
        # Copied out in one step, under the lock, before anything is built
        # from it. `sample()` appends to this deque every tick and `stop`,
        # `reclaim`, `_replace` and `shutdown` each clear it, so walking the
        # live deque while building a dict per reading — bytecode, and
        # interruptible between readings — raises "deque mutated during
        # iteration". That reaches the daemon as an error answer, the daemon
        # posts no kernels at all, and a machine that is online and running
        # work reports holding none for the whole of that poll. Taken in its
        # own block rather than around the whole method: `_state` below
        # reaches for a lock of its own, on the turn rather than this
        # registry, and this mutex is not reentrant.
        with self._lock:
            ring = list(entry.ring)
            latest = entry.latest
        described: dict[str, Any] = {
            "id": kernel_id,
            "sessionId": entry.identity.session_id,
            "taskId": entry.identity.task_id,
            "name": entry.identity.name,
            "language": entry.identity.language,
            "state": self._state(entry),
            "incarnation": entry.incarnation,
            "executionCount": entry.execution_count,
            "queueDepth": entry.turn.depth,
            "environment": entry.identity.environment,
        }
        if entry.kernel is not None:
            described["processId"] = entry.kernel.pid
        # Who ended this kernel and what they said, for as long as it stays
        # ended. Absent rather than null on one nobody ended, and gone again
        # the moment a relaunch clears them — a name here belongs to the
        # incarnation it was said about.
        if entry.stopped_by is not None:
            described["stoppedBy"] = entry.stopped_by
        if entry.stop_reason is not None:
            described["stopReason"] = entry.stop_reason
        # Why the process behind this kernel right now was started, when
        # anything other than a cell arriving started it. Unlike the pair
        # above, this SURVIVES the relaunch — that is the whole point: an idle
        # kernel restarted because its environment was rebuilt has no cell to
        # hand a sentence to, and without this its namespace goes with nothing
        # anywhere saying why. Absent rather than empty for a relaunch nobody
        # explained, and gone again the moment a later relaunch replaces this
        # process with one that has its own answer (or none).
        if entry.restart_reason is not None:
            described["restartReason"] = entry.restart_reason
        resources: dict[str, Any] = {}
        if latest.memory_bytes is not None:
            resources["memoryBytes"] = latest.memory_bytes
        if latest.cpu_percent is not None:
            resources["cpuPercent"] = latest.cpu_percent
        # Absent rather than empty: a kernel nobody has measured must not be
        # reported as one measured at nothing.
        if resources:
            described["resources"] = resources
        # Absent when the ring holds nothing — a restart just cleared it, or
        # nobody has sampled yet — rather than an empty list a sparkline
        # would draw as a flat line for a kernel that was never measured.
        if ring:
            described["series"] = [
                {
                    **({} if s.memory_bytes is None else {"memoryBytes": s.memory_bytes}),
                    **({} if s.cpu_percent is None else {"cpuPercent": s.cpu_percent}),
                }
                for s in ring
            ]
        # Absent rather than zero: nothing has started and nothing has
        # happened are facts about a kernel, and a timestamp of zero is a
        # moment in 1970.
        if entry.started_ts is not None:
            described["startedTs"] = entry.started_ts
        if entry.last_activity_ts is not None:
            described["lastActivityTs"] = entry.last_activity_ts
        if entry.reclaimed_ts is not None:
            described["reclaimedTs"] = entry.reclaimed_ts
        return described

    @staticmethod
    def _state(entry: Entry) -> str:
        # Ended on purpose is asked first, and before "has no process at all".
        # `stop` drops the handle along with the process, so a kernel somebody
        # ended holds no kernel — and read the other way round it would report
        # as one that has never been started, which is a kernel with a
        # namespace still ahead of it rather than one whose namespace went.
        if entry.stopped:
            return "stopped"
        # Asked next, for the same reason: `reclaim()` drops the handle
        # exactly the way `stop()` does, so a kernel this machine took back
        # on its own would otherwise report as one that has never been
        # started — a kernel with a namespace still ahead of it rather than
        # one whose namespace went.
        if entry.reclaimed_ts is not None:
            return "reclaimed"
        if entry.kernel is None:
            return "lazy"
        if not entry.kernel.alive():
            return "crashed"
        return "running" if entry.turn.running else "idle"
