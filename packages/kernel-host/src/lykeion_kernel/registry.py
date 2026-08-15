"""Which kernels this machine is holding, and which cell runs next in each.

A kernel outlives its own process: the identity is what a session addresses,
and a restart replaces what is behind it while keeping the name every call
already uses. Entries appear on the first cell run against an identity, so a
machine holds kernels for the work that happened rather than for the work
that was planned.
"""

from __future__ import annotations

import hashlib
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
from .sampler import Probe, Sample

# One launcher per language this host can start a kernel in, called with the
# identity, the prefix the daemon rendered, the interpreter to run, and the
# directory to run it in.
Launcher = Callable[[KernelIdentity, list[str], str, "str | None"], Kernel]

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
    parts = "\0".join([identity.session_id, identity.task_id, identity.name, identity.language])
    return f"k_{hashlib.sha256(parts.encode('utf-8')).hexdigest()[:16]}"


class Place:
    """One cell's place in the queue of the kernel it was addressed to.

    Taken and waited on separately, because the two happen in different
    places: the order a kernel's cells arrived in exists on the stream they
    arrived on and nowhere after it, while waiting for the cell in front is
    done wherever this cell is going to run.
    """

    def __init__(self, turn: Turn) -> None:
        self.turn = turn

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

    def place(self) -> Place:
        """A place at the back of this queue, taken now and waited on later.

        Nothing here waits, so whatever is reading cells off a stream can
        take each one's place as it reads it and go on reading.
        """
        place = Place(self)
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
    def taken(self, place: Place | None = None) -> Iterator[None]:
        held = self.place() if place is None else place
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
class Confinement:
    """The boundaries one session's kernels are started inside, one per
    language.

    Decided on the other side of the wire and arriving already assembled.
    Nothing in this process can build one, which is what keeps a kernel from
    ever being started outside one — and one boundary per language is what
    keeps a Python cell out of R's library tree.
    """

    prefixes: dict[str, tuple[str, ...]]
    environments: dict[str, str]
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

    def prefix_for(self, language: str) -> tuple[str, ...]:
        return self.prefixes.get(language, ())

    def environment_for(self, language: str) -> str:
        return self.environments.get(language, "")


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
    # The boundary the process behind this entry was started inside, kept as
    # it was at that moment. Configuring a session again decides what the next
    # process gets and moves nothing that is already running, so a record read
    # off the session would name an environment this kernel is not in.
    confinement: Confinement | None = None
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
            prefixes={runnable.language: tuple(prefix) for runnable in self._runnables},
            environments={
                runnable.language: runnable.environment for runnable in self._runnables
            },
        )
        self._sessions: dict[str, Confinement] = {}
        self._entries: dict[str, Entry] = {}
        self._lock = threading.Lock()
        # Where a cell goes once it has run, assigned by whatever holds the
        # stream the lab is reached over. A registry nobody has connected
        # still runs cells: a cell that ran is a fact whether or not
        # anything is listening for it.
        self.on_cell: Callable[[dict[str, Any]], None] | None = None

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
        prefixes: dict[str, list[str]],
        environments: dict[str, str],
        token: str | None = None,
    ) -> None:
        """The boundary this session's kernels are to be started inside.

        A later call replaces what an earlier one said, because a session
        whose environment or workspace changed is a session whose kernels
        have to be started differently — and what is already running was
        started inside the boundary it was given, which a restart is how a
        researcher asks to leave.
        """
        with self._lock:
            self._sessions[session_id] = Confinement(
                prefixes={
                    language: tuple(prefix) for language, prefix in prefixes.items()
                },
                environments=dict(environments),
                task_id=task_id,
                workspace=workspace,
                token=token,
            )

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
        return self._entry_for(kernel_id_for(identity), identity).turn.place()

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
        with entry.turn.taken(place):
            kernel = self._running(entry)
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
            "environment": self._boundary_of(entry).environment_for(identity.language),
            "executionCount": count,
            "source": source,
            "origin": {"surface": origin["surface"], "by": origin["by"]},
            "ok": bool(result.get("ok", False)),
            "wallMs": wall_ms,
            "ts": int(time.time()),
            "outputs": list(result.get("outputs", [])),
        }
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

    def restart(self, kernel_id: str) -> dict[str, Any]:
        """A new process behind the same name, and the kernel as it now is.

        Everything the process it replaces was holding goes with it, which
        is what a researcher asking for a restart is asking for.

        Takes its turn like a cell does, so it waits for the one in front of
        it rather than pulling a namespace out from under a cell halfway
        through writing to it — and so two restarts arriving together leave
        one process behind rather than two. Ending a cell is what an
        interrupt is for.
        """
        entry = self._known(kernel_id)
        with entry.turn.taken():
            self._replace(entry)
        return self._described(kernel_id, entry)

    def list(self) -> list[dict[str, Any]]:
        """One entry per identity this host knows, whether or not a process
        is behind it."""
        with self._lock:
            known = list(self._entries.items())
        return [self._described(kernel_id, entry) for kernel_id, entry in known]

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
        """
        with self._lock:
            self._sessions.pop(session_id, None)
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

    def _boundary_of(self, entry: Entry) -> Confinement:
        """The boundary this kernel is inside, rather than the one its session
        would start the next one inside.

        A process keeps whatever it was launched in until something replaces
        it, and a restart is how a researcher asks for that. Until then a cell
        that named its session's newest environment would be describing a
        result computed somewhere else.

        A kernel nothing has started yet is inside nothing, and what it is
        reported as is what it would be started inside.
        """
        if entry.confinement is not None:
            return entry.confinement
        return self._confinement_for(entry.identity.session_id)

    def _replace(self, entry: Entry) -> Kernel:
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
        prefix = confinement.prefix_for(entry.identity.language)
        if not prefix:
            raise ValueError("no confinement was supplied for this kernel")
        if entry.kernel is not None:
            entry.kernel.stop()
        runnable = self._runnable_for(entry.identity.language)
        entry.kernel = LAUNCHERS[entry.identity.language](
            entry.identity,
            list(prefix),
            runnable.interpreter,
            confinement.workspace,
        )
        entry.probe = Probe(entry.kernel.pid)
        entry.latest = Sample()
        entry.ring.clear()
        entry.confinement = confinement
        entry.incarnation += 1
        entry.execution_count = 0
        entry.started_ts = int(time.time())
        entry.last_activity_ts = None
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
        # own block rather than around the whole method: `_boundary_of` and
        # `_state` below reach for locks of their own, and this mutex is not
        # reentrant.
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
            "environment": self._boundary_of(entry).environment_for(entry.identity.language),
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
