"""The unix socket an agent's relay reaches this host over.

One socket per Task directory, bound where the daemon said. Where that is is
the daemon's decision and this host makes none of it: a socket's name lives in
a fixed-size field far shorter than a Task's own directory, so the name the
daemon sends is a short one that stands for a Task rather than one inside it.
A confined relay may open a connection wherever the socket sits, so nothing
here rests on the name being anywhere in particular.

A connection says which kernel it is for before it says anything else, in one
line the daemon wrote the arguments of. That greeting is checked against what
this host was told about the session, and against the Task directory this
socket was opened for, so a connection cannot reach another Task's work by
asking for it. After it, everything on the connection is the Model Context
Protocol and carries only what to run.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
import threading
from hmac import compare_digest
from typing import Any

from mcp.server.stdio import stdio_server

from ..registry import Registry
from .server import Reach, server_for

# How long a connection is given to say which kernel it is for. A relay
# writes its greeting the moment it connects, so anything slower than this is
# something that opened the socket and had nothing to say — and a listener
# that waited on one forever would accumulate them.
GREETING_S = 10.0

# The language every kernel reached this way is. One until this machine holds
# a second, and named rather than read off the greeting: a connection says
# which kernel it is for, not what a kernel is.
LANGUAGE = "python"

# How much room a unix socket's name has, counted in bytes and including the
# byte that ends it. The smallest of what the platforms this runs on allow, so
# a name this end accepts is one every one of them can bind.
_NAME_LIMIT = 104

# How many connections one Task's socket answers at once. A relay holds one
# for as long as its session lasts, and a Task with this many sessions open at
# the same time is already unusual — so this is generous for the honest case
# and finite for the other one.
#
# Bounded per socket rather than for the host as a whole, which is the whole
# point: this process holds every Task's kernels on the machine, and something
# inside one Task's boundary must not be able to spend a resource the other
# Tasks need. Past this, a connection is refused saying so, rather than
# accepted into a thread this process cannot spare.
MOST_CONNECTIONS = 16

# How much of an opening line is read before a connection is refused for not
# having one. A greeting is a short object the daemon wrote; anything past
# this is something else, and reading it to its end is how one connection
# spends the memory this whole process runs in.
GREETING_BYTES = 8192


class Endpoint:
    """One listening socket, and the connections it has accepted."""

    def __init__(self, path: str, registry: Registry, workspace: str) -> None:
        self._path = path
        self._registry = registry
        # The one Task directory this socket was opened for. A greeting naming
        # a session confined for anywhere else is refused here: the socket this
        # host was asked to open for that directory is the claim, and a
        # session's confinement is what this host was told, so the two agreeing
        # is what makes the pairing this machine's own rather than the
        # caller's.
        self._workspace = workspace
        self._listening = _bound(path)
        self._closed = False
        # How many connections this socket is answering right now, and the
        # lock that makes taking a place and giving one back a single step.
        self._answering = 0
        self._counting = threading.Lock()
        self._accepting = threading.Thread(target=self._accept, daemon=True)
        self._accepting.start()

    @property
    def workspace(self) -> str:
        return self._workspace

    def close(self) -> None:
        """Stops listening and takes the socket file with it.

        A socket file left behind is one the next relay connects to and hangs
        on, so the name goes when the thing behind it does.
        """
        if self._closed:
            return
        self._closed = True
        try:
            self._listening.close()
        except OSError:
            pass
        try:
            os.unlink(self._path)
        except OSError:
            # Already gone, or never ours to remove. Either way there is
            # nothing here to close down.
            pass

    def _accept(self) -> None:
        while not self._closed:
            try:
                connection, _ = self._listening.accept()
            except OSError:
                # The listening socket was closed underneath this, which is
                # this endpoint being shut down.
                return
            with self._counting:
                room = self._answering < MOST_CONNECTIONS
                if room:
                    self._answering += 1
            if not room:
                _too_many(connection)
                continue
            threading.Thread(target=self._answer, args=(connection,), daemon=True).start()

    def _answer(self, connection: socket.socket) -> None:
        try:
            _serve(connection, self._registry, self._workspace)
        finally:
            with self._counting:
                self._answering -= 1
            try:
                connection.close()
            except OSError:
                pass


def _bound(path: str) -> socket.socket:
    """A listening socket at `path`, readable and writable by nobody else.

    Anything already at the name is removed first: a socket file outlives the
    process that bound it, and a host that refused to start over one would be
    a machine that never holds kernels again after a crash.
    """
    # Said in words rather than left to the operating system's own. A unix
    # socket's name lives in a fixed-size field, and the failure it gives for
    # a name that does not fit says nothing about which name or about how much
    # room there was — which is the whole of what a caller needs in order to
    # put the Task somewhere shorter.
    if len(path.encode("utf-8")) >= _NAME_LIMIT:
        raise ValueError(
            f"{path} is {len(path.encode('utf-8'))} bytes, and a unix socket's name "
            f"has room for fewer than {_NAME_LIMIT}"
        )
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    listening = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listening.bind(path)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    listening.listen(8)
    return listening


def _too_many(connection: socket.socket) -> None:
    """Turns a connection away without giving it a thread of its own.

    Answered from the accepting thread and closed there: everything this
    machine holds for every other Task is behind that limit, so a connection
    past it must cost one line and nothing else. That line is read and thrown
    away before the refusal is sent: a socket closed while its peer's own
    line is still in flight answers that write with a broken pipe rather than
    the refusal sitting right behind it, which is a refusal nobody can read.
    """
    try:
        connection.settimeout(GREETING_S)
        connection.recv(GREETING_BYTES)
    except OSError:
        pass
    try:
        connection.sendall(
            (
                json.dumps(
                    {
                        "error": {
                            "message": (
                                f"this Task's kernels are already answering {MOST_CONNECTIONS} "
                                "connections"
                            )
                        }
                    }
                )
                + "\n"
            ).encode("utf-8")
        )
    except OSError:
        pass
    try:
        connection.close()
    except OSError:
        pass


def _greeting(reading: Any) -> dict[str, Any]:
    # Bounded, because everything past the first newline is somebody else's
    # business and reading to the end of a line that never ends is how one
    # connection spends the memory every Task's kernels are held in.
    line = reading.readline(GREETING_BYTES)
    if not line.endswith("\n"):
        raise ValueError("this connection's opening line never ended")
    if not line.strip():
        raise ValueError("this connection said nothing about which kernel it is for")
    said = json.loads(line)
    if not isinstance(said, dict):
        raise ValueError("a connection names its kernel in an object")
    return said


def _same(held: str, said: Any) -> bool:
    """Whether two words match, in a time that does not depend on how much of
    them did."""
    return isinstance(said, str) and compare_digest(held, said)


def _named(said: dict[str, Any], key: str) -> str:
    value = said.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"a connection names its {key}")
    return value


def _reach(said: dict[str, Any], registry: Registry, workspace: str) -> Reach:
    """The kernel a connection may address, or a refusal saying why not."""
    session_id = _named(said, "session")
    task_id = _named(said, "task")
    confined = registry.confinement_for(session_id)
    if confined is None:
        raise ValueError(f"this machine holds no boundary for {session_id}")
    if confined.workspace != workspace:
        raise ValueError(f"{session_id} is not a session of the Task this socket belongs to")
    if confined.task_id != task_id:
        raise ValueError(f"{session_id} is confined for {confined.task_id}, not for {task_id}")
    # One socket answers for every session of its Task, so the Task agreeing
    # is not enough to say WHICH session this is. What settles it is a word
    # the daemon minted for that session and wrote into the relay's own
    # arguments: naming a session is something anyone can do, and holding
    # what was handed to that session's relay is not.
    #
    # Compared without giving anything away about how much of it matched.
    if confined.token is None or not _same(confined.token, said.get("token")):
        raise ValueError(f"this connection was not the one given {session_id}'s kernels")
    return Reach(
        registry=registry,
        # A connection names its kernel, not its environment — the greeting
        # has no such field — so this resolves to whichever environment the
        # session declared as its own default for this language, the same
        # way `host.py`'s own `_identity` does.
        identity=registry.identity_for(session_id, task_id, _named(said, "name"), LANGUAGE, None),
        agent=_named(said, "agent"),
    )


def _refuse(writing: Any, why: str) -> None:
    """Says why a connection is going no further, in a line whatever is on the
    other end can read.

    Written rather than dropped: a relay whose socket simply closed reports a
    server that died, and the agent above it is told nothing it can act on.
    """
    try:
        writing.write(json.dumps({"error": {"message": why}}) + "\n")
        writing.flush()
    except (OSError, ValueError):
        # The other end has gone. There is nobody left to tell.
        return


def _serve(connection: socket.socket, registry: Registry, workspace: str) -> None:
    connection.settimeout(GREETING_S)
    reading = connection.makefile("r", encoding="utf-8")
    writing = connection.makefile("w", encoding="utf-8")
    try:
        reach = _reach(_greeting(reading), registry, workspace)
    except (OSError, ValueError) as refused:
        _refuse(writing, str(refused))
        return
    # Answered before anything else is said, so the relay on the other end can
    # tell being let in from being refused. Without it the two look identical
    # from there — a socket that has said nothing yet — and a relay would have
    # to guess which of them it was in.
    try:
        writing.write(json.dumps({"ready": True}) + "\n")
        writing.flush()
    except (OSError, ValueError):
        return
    # Off the clock the greeting was on. What follows is a conversation that
    # is idle whenever the agent is thinking, and a deadline there would end
    # a kernel's session for the crime of nobody having asked it anything.
    connection.settimeout(None)
    asyncio.run(_conversation(reach, reading, writing))


class _Awaited:
    """One end of a connection, as the protocol's own transport reads and
    writes one.

    That transport iterates lines and awaits its writes, while a socket's file
    object does both by blocking. Each call goes to a worker thread, so what a
    connection waits on is the cell it is running and never the reading of the
    next message.
    """

    def __init__(self, stream: Any) -> None:
        self._stream = stream

    def __aiter__(self) -> _Awaited:
        return self

    async def __anext__(self) -> str:
        line = await asyncio.to_thread(self._stream.readline)
        if not line:
            raise StopAsyncIteration
        return line

    async def write(self, text: str) -> int:
        return await asyncio.to_thread(self._stream.write, text)

    async def flush(self) -> None:
        await asyncio.to_thread(self._stream.flush)


async def _conversation(reach: Reach, reading: Any, writing: Any) -> None:
    server = server_for(reach)
    # The same file objects the greeting was read and answered on, so bytes
    # already buffered behind that first newline are not left in a reader
    # nothing goes back to.
    async with stdio_server(stdin=_Awaited(reading), stdout=_Awaited(writing)) as (
        incoming,
        outgoing,
    ):
        await server.run(incoming, outgoing, server.create_initialization_options())


class Endpoints:
    """Every socket this host is listening on, one per Task directory.

    A second session on a Task reaches the socket the first one's session
    opened: the connection says which kernel it is for, so one socket answers
    for every session of that Task and there is nothing to open twice.
    """

    def __init__(self, registry: Registry) -> None:
        self._registry = registry
        self._open: dict[str, Endpoint] = {}
        self._lock = threading.Lock()

    def listen(self, path: str, workspace: str) -> None:
        with self._lock:
            standing = self._open.get(path)
            if standing is not None and standing.workspace == workspace:
                return
            if standing is not None:
                standing.close()
            self._open[path] = Endpoint(path, self._registry, workspace)

    def close(self) -> None:
        with self._lock:
            listening = list(self._open.values())
            self._open.clear()
        for endpoint in listening:
            endpoint.close()

    @property
    def paths(self) -> list[str]:
        with self._lock:
            return list(self._open)
