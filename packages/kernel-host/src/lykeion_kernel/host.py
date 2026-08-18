"""The process a machine holds its kernels in.

Started by the daemon and outside every boundary, because it is the thing
that puts other processes inside one. It renders no profile and has no way
to: the argv prefix a kernel is spawned behind arrives from the daemon
already built.

No method is undeliverable because another is running. One thread reads the
stream and decides only what each message is; every call is answered off it.
A cell holds a kernel for as long as it runs, and `kernel.interrupt` exists
for the one that will not come back — a loop that could not read that
message until the cell returned would leave killing this process as the only
way out, which ends every session's kernels on the machine.

What that leaves ordered is one thing: the cells of one kernel run in the
order they arrived here, because each takes its place in that kernel's queue
on the reading thread rather than on the thread that runs it. Nothing else
is. Two calls where one's effect is what the other needs — a session's
confinement before the cells that are to be started inside it, a restart
before the cell meant for the new process — are sequenced by whoever is
calling, by waiting for the first reply before sending the second. A caller
that sends both at once will sometimes have them answered in the other
order, and for the confinement that reads as a cell refused for a boundary
this host had not been told about yet.
"""

from __future__ import annotations

import queue
import sys
import threading
import time
from typing import Any, Callable, IO, NamedTuple

from .kernels import KernelIdentity
from .mcp.endpoint import Endpoints
from .protocol import PROTOCOL_VERSION, is_reply, read_messages, write_message
from .registry import Place, Registry
from .sampler import total_memory

# How long the calls still being answered are given, together, once the
# stream has ended. Long enough for one that was about to finish to write
# what it found, and bounded because a call still running past it is a cell
# that is not coming back on its own — ending its kernel is what unblocks
# it, which is the shutdown this wait is in front of.
DRAINING_S = 5.0

class Holding(NamedTuple):
    """Everything this host is keeping: the kernels, and the sockets an agent
    reaches them over."""

    registry: Registry
    endpoints: Endpoints


# One call, as this host answers it: what it was asked, and the place its
# cell already holds in a kernel's queue when it is a cell at all.
Handler = Callable[[Holding, dict[str, Any], Place | None], dict[str, Any]]


def _hello(holding: Holding, _params: dict[str, Any], _place: Place | None) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL_VERSION,
        "languages": [
            {
                "language": runnable.language,
                "environment": runnable.environment,
                "interpreter": runnable.interpreter,
                "reads": list(runnable.reads),
            }
            for runnable in holding.registry.runnables
        ],
    }


class Cell(NamedTuple):
    """A cell as a message asks for one.

    Read out of a message in one place, because two readings of it could
    disagree about whether a message is a cell at all — and this machine
    decides that twice: once where the cell takes its place in a kernel's
    queue, and once where it is run. The identity is the one field those two
    readings must not decide independently — see `_cell`'s own `identity`
    argument.
    """

    identity: KernelIdentity
    source: str
    origin: dict[str, str]
    tool_use_id: str | None


def _cell(
    holding: Holding, params: dict[str, Any], identity: KernelIdentity | None = None
) -> Cell:
    """A cell as this message asks for one, resolving its identity only when
    none is already known.

    `identity_for` reads live session state, so calling it here a second
    time for a cell whose place was already taken is not "the same answer,
    computed again" — a session reconfigured in between can make it a
    different one. The caller that already has the answer, from the `Place`
    its own earlier call to this took, passes it forward; only a caller with
    no place at all — a cell this host is about to refuse either way — asks
    this to resolve one.
    """
    source = params.get("source")
    if not isinstance(source, str):
        raise ValueError("a cell has a source, even an empty one")
    tool_use_id = params.get("tool_use_id")
    return Cell(
        identity=identity if identity is not None else _identity(holding, params),
        source=source,
        origin=_origin(params),
        tool_use_id=tool_use_id if isinstance(tool_use_id, str) and tool_use_id else None,
    )


def _execute(holding: Holding, params: dict[str, Any], place: Place | None) -> dict[str, Any]:
    # The identity this cell runs against is the one its place was taken
    # for, not a fresh resolution: `place.identity` and the identity a
    # second call to `identity_for` would produce can disagree if the
    # session was reconfigured between the two — and `execute`'s own
    # `place` argument is only ever waited on inside the turn that
    # identity's own kernel holds. A cell with no place — refused at
    # arrival, redone here to answer with why — resolves its own, since
    # there is no earlier answer to carry forward.
    cell = _cell(holding, params, place.identity if place is not None else None)
    return holding.registry.execute(
        cell.identity,
        cell.source,
        origin=cell.origin,
        tool_use_id=cell.tool_use_id,
        place=place,
    )


def _configure_session(
    holding: Holding, params: dict[str, Any], _place: Place | None
) -> dict[str, Any]:
    workspace = _text(params, "workspace")
    token = params.get("token")
    # `configure_session` is the one place this shape is validated — see
    # `_environments_from` in registry.py. Passed straight through rather
    # than parsed twice: the registry is reachable directly and not only
    # from this wire, so the check belongs where the invariant does.
    holding.registry.configure_session(
        session_id=_text(params, "session_id"),
        task_id=_text(params, "task_id"),
        workspace=workspace,
        environments=params.get("environments"),
        token=token if isinstance(token, str) and token else None,
        # `.get` rather than a default of `[]`: a message carrying no
        # `declared` key is a daemon whose own ask of the lab failed, and a
        # session told nothing about the lab's declarations must not be
        # configured as one told the lab has none. The registry keeps the
        # two apart and says different things for them.
        declared=params.get("declared"),
    )
    # After the session is known and never before it: the greeting a
    # connection opens with is checked against exactly this, so a socket that
    # existed first would be one an agent could reach before this host could
    # say which kernels it answers for.
    socket = params.get("socket")
    if isinstance(socket, str) and socket:
        holding.endpoints.listen(socket, workspace)
    return {}


def _interrupt(holding: Holding, params: dict[str, Any], _place: Place | None) -> dict[str, Any]:
    holding.registry.interrupt(_text(params, "kernel_id"))
    return {}


def _stop(holding: Holding, params: dict[str, Any], _place: Place | None) -> dict[str, Any]:
    holding.registry.stop(
        _text(params, "kernel_id"),
        feedback=params.get("feedback"),
        by=params.get("by"),
    )
    return {}


def _restart(holding: Holding, params: dict[str, Any], _place: Place | None) -> dict[str, Any]:
    return holding.registry.restart(_text(params, "kernel_id"))


def _restart_environment(
    holding: Holding, params: dict[str, Any], _place: Place | None
) -> dict[str, Any]:
    """Every kernel started in one environment, given a fresh process.

    Named by ENVIRONMENT and not by session, and deliberately answerable
    without one: what has changed is a directory on this machine, and every
    session that has a kernel in it is affected whether or not it is the
    session whose agent asked. A method that needed a session here would
    leave a colleague's kernel running against an interpreter this machine
    has just deleted.

    `reason` is optional the same way `kernel.stop`'s `feedback` is: the
    daemon sends one when it knows why, and a restart with nothing said is
    still a restart.
    """
    return {
        "restarted": holding.registry.restart_environment(
            _text(params, "name"), _optional_text(params, "reason")
        )
    }


def _list(holding: Holding, _params: dict[str, Any], _place: Place | None) -> dict[str, Any]:
    return {"kernels": holding.registry.list()}


def _release_session(
    holding: Holding, params: dict[str, Any], _place: Place | None
) -> dict[str, Any]:
    return {"released": holding.registry.release_session(_text(params, "session_id"))}


METHODS: dict[str, Handler] = {
    "host.hello": _hello,
    "kernel.configure_session": _configure_session,
    "kernel.execute": _execute,
    "kernel.interrupt": _interrupt,
    "kernel.stop": _stop,
    "kernel.restart": _restart,
    "kernel.restart_environment": _restart_environment,
    "kernel.list": _list,
    "kernel.release_session": _release_session,
}


def _text(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"this call needs a {key}")
    return value


def _optional_text(params: dict[str, Any], key: str) -> str | None:
    value = params.get(key)
    return value if isinstance(value, str) and value else None


def _identity(holding: Holding, params: dict[str, Any]) -> KernelIdentity:
    return holding.registry.identity_for(
        _text(params, "session_id"),
        _text(params, "task_id"),
        _text(params, "name"),
        _text(params, "language"),
        _optional_text(params, "environment"),
    )


def _origin(params: dict[str, Any]) -> dict[str, str]:
    # The agent and the researcher share one namespace, so a cell that does
    # not say which of them produced it is a record nobody can read back.
    origin = params.get("origin")
    if not isinstance(origin, dict):
        raise ValueError("a cell says where it came from")
    surface = origin.get("surface")
    if surface not in ("agent", "repl"):
        raise ValueError(f"a cell is run from the agent or the repl, not from {surface}")
    by = origin.get("by")
    if not isinstance(by, str) or not by:
        raise ValueError("a cell says who ran it")
    return {"surface": surface, "by": by}


def _arriving(holding: Holding, method: str, params: dict[str, Any]) -> Place | None:
    """The place this message's cell takes in its kernel's queue.

    Taken on the reading thread, in the order the cells were read, because
    that order exists on this stream and nowhere after it: the threads that
    answer them are started in that order and run in whichever order the
    platform decides. A cell that took its place where it is run would leave
    a notebook read back in an order nobody ran it in.

    A message that is not a cell, and one this host is going to refuse for
    what it is missing, take no place and mint no kernel: a machine holds
    kernels for the work that happened. The refusal itself is written where
    every other refusal is.

    Nothing a message can do reaches past this. Deciding a place is the one
    thing done for a call before it is dispatched, and it runs on the thread
    holding every session's kernels on this machine — so anything raised here
    is left to the same reading, redone where the cell is run, that is going
    to answer for it.
    """
    if method != "kernel.execute":
        return None
    try:
        return holding.registry.arriving(_cell(holding, params).identity)
    except Exception:  # noqa: BLE001 - answered from the thread, never here
        return None


def _answer(
    holding: Holding,
    stdout: IO[str],
    handler: Handler,
    params: dict[str, Any],
    request_id: Any,
    place: Place | None,
) -> None:
    """One call, run and answered away from the stream it arrived on."""
    try:
        try:
            reply = {"result": handler(holding, params, place)}
        except Exception as failure:  # noqa: BLE001 - reported, never swallowed
            reply = {"error": {"message": str(failure)}}
    finally:
        # Given back however the cell turned out, because a place nothing
        # gives back is a kernel that never runs another cell. A cell that
        # ran took its own place off the queue and this finds none to give.
        if place is not None:
            place.left()
    if request_id is not None:
        write_message(stdout, {"id": request_id, **reply})


class Asking:
    """What this host wants FROM the daemon, and the threads waiting on it.

    The other direction of `_answer`. Some things a tool call needs are not
    this process's to do — raising a permission card in front of the
    researcher, and calling the lab with their session's own token — and
    this process holds neither the session nor the token. So it asks, and
    the thread that asked waits for the answer.

    Its own id counter, starting at 1 and independent of the daemon's. The
    two spaces never meet: each end matches replies against its own
    outstanding map, so an ask numbered 1 here and a request numbered 1
    there are different messages travelling in opposite directions, and
    neither end ever looks for the other's id.

    Every ask blocks the thread that made it and nothing else. Replies land
    on the reading thread, which does no work beyond handing one to whichever
    thread is waiting — so a card the researcher takes a minute over holds up
    that one tool call and no cell on this machine.
    """

    def __init__(self, stdout: IO[str]) -> None:
        self._stdout = stdout
        self._lock = threading.Lock()
        self._next_id = 1
        # One slot per outstanding ask. A queue rather than an Event plus a
        # box, because the two halves of that pair can be read apart: a
        # thread woken by the event still has to find the result somebody
        # else may already be clearing.
        self._waiting: dict[int, queue.Queue[dict[str, Any]]] = {}
        # Why nothing more can be asked, once the stream this travels on has
        # ended. `None` while the daemon is still there.
        self._closed: str | None = None

    def ask(self, method: str, params: dict[str, Any]) -> Any:
        """Asks the daemon for something, and waits here for its answer.

        Raises `ValueError` carrying the daemon's own message when it
        refuses — the daemon is where a researcher's decision and the lab's
        own refusals are, and its sentence is the one worth passing on.
        """
        with self._lock:
            if self._closed is not None:
                raise ValueError(self._closed)
            ask_id = self._next_id
            self._next_id += 1
            slot: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
            self._waiting[ask_id] = slot
        try:
            write_message(self._stdout, {"id": ask_id, "method": method, "params": params})
        except Exception:
            # Nothing is coming for an ask that was never sent. Taking the
            # slot back here is what keeps `settle_all` from later reporting
            # a stream failure as an unanswered question.
            with self._lock:
                self._waiting.pop(ask_id, None)
            raise
        message = slot.get()
        error = message.get("error")
        if error is not None:
            raise ValueError(
                error.get("message") if isinstance(error, dict) else str(error)
            )
        return message.get("result")

    def deliver(self, message: dict[str, Any]) -> None:
        """Hands one reply to whichever thread is waiting on it.

        A reply naming an id nothing is waiting for is dropped: the ask it
        answers was already settled — by `settle_all`, or by a write that
        never left — and there is no second thread to wake.
        """
        ask_id = message.get("id")
        with self._lock:
            slot = self._waiting.pop(ask_id, None) if isinstance(ask_id, int) else None
        if slot is not None:
            slot.put(message)

    def settle_all(self, reason: str) -> None:
        """Fails every ask still waiting, and refuses every later one.

        Called where the stream ends. A daemon that closed this host's stdin
        is never going to answer, and a thread blocked on a reply that is not
        coming would sit out the whole draining deadline for nothing —
        holding up the shutdown it is inside, to wait for a message from a
        process that has already gone.
        """
        with self._lock:
            self._closed = reason
            waiting = list(self._waiting.values())
            self._waiting.clear()
        for slot in waiting:
            slot.put({"error": {"message": reason}})


SAMPLE_INTERVAL_S = 2.0


def _sampling(registry: Registry, share: float | None = None) -> threading.Thread:
    """Reads every kernel's process on its own clock, and takes back memory
    this machine cannot spare.

    A daemon thread, because a host with nothing left to serve must not be
    held open by a timer. Sampling continues whether or not anyone is
    looking: history that only exists while a screen is open is a record of
    who was watching.

    `reclaim()` runs on the same tick, right after `sample()`: the figures it
    judges pressure against are only as fresh as the reading that just
    finished, and a separate clock for the policy would have it acting on a
    machine's state from its own last tick rather than this one's. `share` is
    what the daemon asked kernels be held under at launch; `None` when it
    asked for nothing in particular, which leaves `reclaim()`'s own default
    in force.
    """

    def loop() -> None:
        while True:
            time.sleep(SAMPLE_INTERVAL_S)
            try:
                registry.sample()
                # What this machine has, and what its kernels are holding of
                # it — summed from the reading `sample()` just took, over
                # only the kernels that reading could measure. A kernel
                # nobody has measured yet contributes nothing to the sum,
                # the same as one truly holding nothing would.
                machine_memory = total_memory()
                held = sum(
                    entry.get("resources", {}).get("memoryBytes", 0)
                    for entry in registry.list()
                )
                overridden = {} if share is None else {"share": share}
                registry.reclaim(total_memory=machine_memory, holding=held, **overridden)
            except Exception:
                # A sampler that raised would take the whole timer with it and
                # leave every figure frozen at its last value, which reads as
                # a measurement. Missing one tick is the smaller lie.
                continue

    thread = threading.Thread(target=loop, daemon=True, name="kernel-sampler")
    thread.start()
    return thread


def serve(
    stdin: IO[str],
    stdout: IO[str],
    registry: Registry | None = None,
    *,
    share: float | None = None,
) -> None:
    # No prefix of its own. Nothing in this process can render a boundary,
    # so a host that has not been handed one holds no kernels rather than
    # starting interpreters outside every boundary this machine has.
    kernels = Registry([]) if registry is None else registry
    holding = Holding(registry=kernels, endpoints=Endpoints(kernels))
    # The return is what the caller awaited; the notification is what reaches
    # the lab. One event, written twice, because the two ends of it are
    # waiting in different places.
    kernels.on_cell = lambda cell: write_message(stdout, {"method": "cell", "params": cell})
    # The other direction, wired the same way and for the same reason: what
    # a tool call needs that only the daemon can do — a permission card in
    # front of the researcher, and the lab called with their session's own
    # token — goes out here and is waited on by the thread that asked.
    asking = Asking(stdout)
    kernels.ask_daemon = asking.ask
    _sampling(kernels, share)
    answering: list[threading.Thread] = []
    try:
        for message in read_messages(stdin):
            # Before anything looks for a handler. A reply carries an id and
            # no method, so a loop that read it as a request would answer it
            # with "no method named None" and leave whichever thread is
            # waiting on it blocked for good.
            if is_reply(message):
                asking.deliver(message)
                continue
            request_id = message.get("id")
            method = message.get("method")
            handler = METHODS.get(method) if isinstance(method, str) else None
            if handler is None:
                # Answered rather than dropped, and answered here rather than
                # off the loop because naming a method back is no work. A
                # request that gets no reply leaves the daemon waiting on a
                # promise nothing will settle, which reads as a hung machine
                # rather than as a missing method.
                if request_id is not None:
                    write_message(
                        stdout,
                        {"id": request_id, "error": {"message": f"no method named {method}"}},
                    )
                continue
            params = message.get("params")
            if params is None:
                params = {}
            if not isinstance(params, dict):
                # Answered here, and answered rather than dropped for the same
                # reason an unknown method is. A call whose params are not an
                # object has no field anything below could be asked for, and
                # this loop is where that has to be found: every session's
                # kernels on this machine are behind it, and one message
                # nobody can read must not be the end of all of them.
                if request_id is not None:
                    write_message(
                        stdout,
                        {"id": request_id, "error": {"message": "a call's params are an object"}},
                    )
                continue
            # Where a cell's order still exists, and the only work this loop
            # does on a message's behalf. Nothing here waits.
            place = _arriving(holding, method, params)
            # One thread per call, rather than a pool: a cell holds whatever
            # is running it for as long as it runs, so a bounded pool whose
            # workers were all inside cells could not deliver the interrupt
            # that would free them. The loop itself decides only what a
            # message is, so the next one is read while this one is answered.
            answering = [thread for thread in answering if thread.is_alive()]
            thread = threading.Thread(
                target=_answer,
                args=(holding, stdout, handler, params, request_id, place),
                daemon=True,
            )
            answering.append(thread)
            thread.start()
    finally:
        # A daemon that has closed this host's stdin is never going to answer,
        # so every thread waiting on one is waiting for something that is not
        # coming, and every later ask is asking a process that has gone. Both
        # are settled here rather than left: a thread blocked on a reply is
        # inside a tool call somebody is watching, and a wait nothing can end
        # is indistinguishable from a machine that has stopped answering.
        #
        # Before the join below because that reads well, NOT because it
        # shortens it: the join covers `answering` — the threads started for
        # `METHODS` handlers — and no handler in `METHODS` asks the daemon for
        # anything. The only caller is the MCP endpoint's own thread, which is
        # not in that list, so the placement buys nothing against the draining
        # deadline and this comment should not claim it does.
        asking.settle_all("this machine's daemon is no longer answering")
        # What is still being answered gets until the deadline between them,
        # so a call that was about to finish writes what it found. Bounded
        # rather than bare, because a cell that will not come back would
        # otherwise be a host that never stops — and past the bound the
        # shutdown below is what ends its kernel, which is what unblocks it.
        deadline = time.monotonic() + DRAINING_S
        for thread in answering:
            thread.join(timeout=max(0.0, deadline - time.monotonic()))
        # Before the kernels, so nothing new arrives on a socket while the
        # namespaces behind it are being ended — and so the socket files go
        # with the process that bound them rather than being left for the next
        # relay to connect to and wait on.
        holding.endpoints.close()
        # The daemon closing this host's stdin is the end of every kernel it
        # was holding for it. A host that returned without saying so would
        # leave interpreters on the machine with nothing at the other end.
        holding.registry.shutdown()


def main() -> None:
    # No `share` of its own: nothing on this machine's command line says one
    # today, so this passes none and leaves `_sampling`'s and `reclaim`'s own
    # default in force. `serve` still takes the argument — for a daemon this
    # process is embedded in and could construct with one directly, and for a
    # later launcher that does read it off argv, which needs no change here
    # to do so.
    serve(sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
