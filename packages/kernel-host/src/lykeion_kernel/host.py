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

import sys
import threading
import time
from typing import Any, Callable, IO, NamedTuple

from .kernels import KernelIdentity
from .mcp.endpoint import Endpoints
from .protocol import PROTOCOL_VERSION, read_messages, write_message
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
    queue, and once where it is run.
    """

    identity: KernelIdentity
    source: str
    origin: dict[str, str]
    tool_use_id: str | None


def _cell(params: dict[str, Any]) -> Cell:
    source = params.get("source")
    if not isinstance(source, str):
        raise ValueError("a cell has a source, even an empty one")
    tool_use_id = params.get("tool_use_id")
    return Cell(
        identity=_identity(params),
        source=source,
        origin=_origin(params),
        tool_use_id=tool_use_id if isinstance(tool_use_id, str) and tool_use_id else None,
    )


def _execute(holding: Holding, params: dict[str, Any], place: Place | None) -> dict[str, Any]:
    cell = _cell(params)
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
    holding.registry.configure_session(
        session_id=_text(params, "session_id"),
        task_id=_text(params, "task_id"),
        workspace=workspace,
        prefixes=_prefixes(params),
        environments=_environments(params),
        token=token if isinstance(token, str) and token else None,
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
    "kernel.list": _list,
    "kernel.release_session": _release_session,
}


def _text(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"this call needs a {key}")
    return value


def _prefixes(params: dict[str, Any]) -> dict[str, list[str]]:
    # One argument list per language, and nothing else. Anything this process
    # cannot concatenate an interpreter onto is refused where it arrived
    # rather than where a kernel would fail to start.
    prefixes = params.get("prefixes")
    if not isinstance(prefixes, dict):
        raise ValueError("a confinement is one argument list per language")
    built: dict[str, list[str]] = {}
    for language, prefix in prefixes.items():
        if (
            not isinstance(language, str)
            or not isinstance(prefix, list)
            or not all(isinstance(part, str) for part in prefix)
        ):
            raise ValueError("a confinement is one argument list per language")
        built[language] = list(prefix)
    return built


def _environments(params: dict[str, Any]) -> dict[str, str]:
    environments = params.get("environments")
    if not isinstance(environments, dict) or not all(
        isinstance(language, str) and isinstance(name, str)
        for language, name in environments.items()
    ):
        raise ValueError("an environment is named once per language")
    return dict(environments)


def _identity(params: dict[str, Any]) -> KernelIdentity:
    return KernelIdentity(
        session_id=_text(params, "session_id"),
        task_id=_text(params, "task_id"),
        name=_text(params, "name"),
        language=_text(params, "language"),
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
        return holding.registry.arriving(_cell(params).identity)
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
    _sampling(kernels, share)
    answering: list[threading.Thread] = []
    try:
        for message in read_messages(stdin):
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
