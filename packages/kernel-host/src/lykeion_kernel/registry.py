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

from .kernels import KernelIdentity
from .kernels.python import PythonKernel, launch

# The environment a kernel of this machine runs in. One name until a machine
# holds more than one, and carried on every cell because a result computed
# in a different environment is a different result.
DEFAULT_ENVIRONMENT = "python"


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
    """The boundary one session's kernels are started inside.

    Decided on the other side of the wire and arriving already assembled: an
    argv prefix an interpreter is concatenated onto, the one directory that
    boundary lets a kernel write, and the environment those kernels run in.
    Nothing in this process can build one, which is what keeps a kernel from
    ever being started outside one.
    """

    prefix: tuple[str, ...]
    environment: str
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


@dataclass
class Entry:
    """One identity, and whatever is behind it at the moment."""

    identity: KernelIdentity
    turn: Turn = field(default_factory=Turn)
    kernel: PythonKernel | None = None
    incarnation: int = 0
    execution_count: int = 0
    started_ts: int | None = None
    last_activity_ts: int | None = None
    # Whether this machine ended the process on purpose. A kernel that was
    # stopped and a kernel that died are different facts, and the second is
    # never reported as the first.
    stopped: bool = False
    # The boundary the process behind this entry was started inside, kept as
    # it was at that moment. Configuring a session again decides what the next
    # process gets and moves nothing that is already running, so a record read
    # off the session would name an environment this kernel is not in.
    confinement: Confinement | None = None


class Registry:
    """Every kernel this host holds, and the one way to run a cell in one."""

    def __init__(
        self,
        prefix: list[str],
        *,
        environment: str = DEFAULT_ENVIRONMENT,
        interpreter: str = sys.executable,
    ) -> None:
        # What a session this host was told nothing about falls back to. A
        # host is constructed before any session exists and `serve()` passes
        # no prefix at all, so the fallback starts nothing until a daemon has
        # said what a boundary is.
        self._unconfigured = Confinement(prefix=tuple(prefix), environment=environment)
        self._sessions: dict[str, Confinement] = {}
        self._interpreter = interpreter
        self._entries: dict[str, Entry] = {}
        self._lock = threading.Lock()
        # Where a cell goes once it has run, assigned by whatever holds the
        # stream the lab is reached over. A registry nobody has connected
        # still runs cells: a cell that ran is a fact whether or not
        # anything is listening for it.
        self.on_cell: Callable[[dict[str, Any]], None] | None = None

    @property
    def interpreter(self) -> str:
        """The interpreter every kernel here is launched through.

        Reported because the daemon renders the boundary and cannot work this
        out: which interpreter this process is running is a fact about how it
        was started, and a boundary that did not let a kernel read it would
        refuse the kernel before its first instruction.
        """
        return self._interpreter

    def configure_session(
        self,
        *,
        session_id: str,
        task_id: str,
        workspace: str,
        environment: str,
        prefix: list[str],
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
                prefix=tuple(prefix),
                environment=environment,
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
        kernel_id = kernel_id_for(identity)
        entry = self._entry_for(kernel_id, identity)
        with entry.turn.taken(place):
            kernel = self._running(entry)
            began = time.monotonic()
            result = kernel.execute(source)
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
            "environment": self._boundary_of(entry).environment,
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

        A kernel with nothing in it is signalled all the same rather than
        checked first: a cell can finish inside the gap such a check would
        open. What makes that safe is the kernel itself, which takes signals
        only for the length of a cell and is deaf to them everywhere else —
        so an interrupt arriving a moment late is delivered nowhere rather
        than to whatever ran next.
        """
        entry = self._known(kernel_id)
        if entry.kernel is not None:
            entry.kernel.interrupt()

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

    def _running(self, entry: Entry) -> PythonKernel:
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

    def _replace(self, entry: Entry) -> PythonKernel:
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
        if not confinement.prefix:
            raise ValueError("no confinement was supplied for this kernel")
        if entry.kernel is not None:
            entry.kernel.stop()
        entry.kernel = launch(
            entry.identity,
            list(confinement.prefix),
            interpreter=self._interpreter,
            cwd=confinement.workspace,
        )
        entry.confinement = confinement
        entry.incarnation += 1
        entry.execution_count = 0
        entry.started_ts = int(time.time())
        entry.last_activity_ts = None
        entry.stopped = False
        return entry.kernel

    def _described(self, kernel_id: str, entry: Entry) -> dict[str, Any]:
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
            "environment": self._boundary_of(entry).environment,
        }
        # Absent rather than zero: nothing has started and nothing has
        # happened are facts about a kernel, and a timestamp of zero is a
        # moment in 1970.
        if entry.started_ts is not None:
            described["startedTs"] = entry.started_ts
        if entry.last_activity_ts is not None:
            described["lastActivityTs"] = entry.last_activity_ts
        return described

    @staticmethod
    def _state(entry: Entry) -> str:
        if entry.kernel is None:
            return "lazy"
        if entry.stopped:
            return "stopped"
        if not entry.kernel.alive():
            return "crashed"
        return "running" if entry.turn.running else "idle"
