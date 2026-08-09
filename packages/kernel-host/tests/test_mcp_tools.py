"""What an agent gets when it calls one of this machine's tools.

Driven through a real MCP session against a real interpreter: the client is
the SDK's own, the server is the one a connection is answered by, and the
kernel behind it is a process on the machine running these tests. What is
asserted is the cell that comes back, because the cell is the whole of what a
tool call produces — the agent reads one half of it and the lab keeps the
other.
"""

from __future__ import annotations


import ast
import functools
import io
import json
import shutil
import tempfile
import os
import socket
import sys
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any, Iterator, NamedTuple

import anyio
import anyio.from_thread
import pytest
from mcp.client.session import ClientSession
from mcp.shared.memory import create_client_server_memory_streams

from lykeion_kernel.kernels import KernelIdentity
from lykeion_kernel.mcp.endpoint import (
    Endpoints,
    GREETING_BYTES,
    MOST_CONNECTIONS,
    _greeting as opening_line,
)
from lykeion_kernel.mcp.server import Reach, server_for
from lykeion_kernel.registry import Registry


class Calling(NamedTuple):
    """One agent's end of a live MCP session."""

    call: Any
    tools: Any


@asynccontextmanager
async def _session(reach: Reach):
    server = server_for(reach)
    async with create_client_server_memory_streams() as (client, serving):
        async with anyio.create_task_group() as answering:

            async def run() -> None:
                await server.run(
                    serving[0], serving[1], server.create_initialization_options(), raise_exceptions=True
                )

            answering.start_soon(run)
            async with ClientSession(client[0], client[1]) as session:
                await session.initialize()
                yield session
            answering.cancel_scope.cancel()


@pytest.fixture
def mcp(registry: Registry, tmp_path) -> Iterator[Calling]:
    """An agent talking to the kernel the daemon named for it.

    The session is configured first, exactly as the daemon configures one
    before an agent is ever told a tool server exists — a kernel whose
    boundary this host has not been told about is one it refuses to start.
    """
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environment="python",
        prefix=["/usr/bin/env"],
    )
    reach = Reach(
        registry=registry,
        identity=KernelIdentity(
            session_id="se_1", task_id="tk_1", name="main", language="python"
        ),
        agent="claude",
    )
    with anyio.from_thread.start_blocking_portal() as portal:
        with portal.wrap_async_context_manager(_session(reach)) as session:

            def call(
                name: str,
                arguments: dict[str, Any],
                meta: dict[str, Any] | None = None,
            ) -> dict[str, Any]:
                answer = portal.call(
                    functools.partial(session.call_tool, name, arguments, meta=meta)
                )
                return {
                    "cell": answer.structured_content["cell"],
                    "text": "".join(
                        block.text for block in answer.content if block.type == "text"
                    ),
                    "isError": bool(answer.is_error),
                }

            yield Calling(call=call, tools=lambda: portal.call(session.list_tools))


def stdout_of(answer: dict[str, Any]) -> str:
    """Everything the cell wrote to its own standard output."""
    return "".join(
        output.get("text", "")
        for output in answer["cell"]["outputs"]
        if output.get("kind") == "stream" and output.get("name") == "stdout"
    )


def test_run_python_lands_in_the_kernel_named_by_the_bridge(mcp: Calling):
    mcp.call("run_python", {"code": "y = 7"})
    assert "7" in stdout_of(mcp.call("run_python", {"code": "print(y)"}))


def test_a_tool_call_carries_its_identity_into_the_cell(mcp: Calling):
    cell = mcp.call("run_python", {"code": "1"})["cell"]
    assert cell["name"] == "main"
    assert cell["origin"] == {"surface": "agent", "by": "claude"}


def test_a_call_whose_meta_names_its_tool_use_id_leaves_it_on_the_cell(mcp: Calling):
    # Claude Code forwards the id its own transcript keeps for the call, under
    # a vendor key. The cell keeps it, so the notebook record and the agent's
    # execution log name the same event.
    cell = mcp.call(
        "run_python", {"code": "1"}, meta={"claudecode/toolUseId": "toolu_01x"}
    )["cell"]
    assert cell["toolUseId"] == "toolu_01x"


def test_a_shell_call_carries_its_tool_use_id_the_same_way(mcp: Calling):
    cell = mcp.call(
        "run_shell", {"command": "true"}, meta={"toolUseId": "exec-4f"}
    )["cell"]
    assert cell["toolUseId"] == "exec-4f"


def test_a_call_with_no_meta_leaves_the_cell_without_a_tool_use_id(mcp: Calling):
    # Absent rather than null: a provider that forwarded nothing said nothing,
    # and the daemon may still join the cell to its step by observation.
    cell = mcp.call("run_python", {"code": "1"})["cell"]
    assert "toolUseId" not in cell


def test_both_calls_reach_the_same_kernel(mcp: Calling):
    # The kernel is decided when the server is built and cannot be named by a
    # tool call, so two calls that could not have said which kernel they meant
    # are in one namespace whether or not they say so.
    first = mcp.call("run_python", {"code": "1"})["cell"]
    second = mcp.call("run_shell", {"command": "true"})["cell"]
    assert first["kernelId"] == second["kernelId"]


def test_a_tool_names_nothing_a_caller_could_point_at_another_kernel(mcp: Calling):
    published = {tool.name: tool.input_schema for tool in mcp.tools().tools}
    assert sorted(published) == ["run_python", "run_shell"]
    assert list(published["run_python"]["properties"]) == ["code"]
    assert list(published["run_shell"]["properties"]) == ["command"]


def test_run_shell_brings_its_output_back_as_the_cell_it_ran(mcp: Calling):
    answer = mcp.call("run_shell", {"command": "echo eleven rows"})
    assert "eleven rows" in stdout_of(answer)
    assert answer["cell"]["ok"] is True


def test_a_shell_command_leaves_the_researchers_own_names_alone(mcp: Calling):
    mcp.call("run_python", {"code": "subprocess = 'mine'"})
    mcp.call("run_shell", {"command": "echo hello"})
    assert "mine" in stdout_of(mcp.call("run_python", {"code": "print(subprocess)"}))


def test_a_quote_in_a_command_is_part_of_it_and_not_the_end_of_it(mcp: Calling):
    # The command travels as one string inside an argument list, so nothing in
    # it can close the list and become code of its own.
    answer = mcp.call("run_shell", {"command": "printf '%s' \"it's one argument\""})
    assert stdout_of(answer) == "it's one argument"


def test_a_shell_command_that_failed_says_so_without_ending_the_cell(mcp: Calling):
    answer = mcp.call("run_shell", {"command": "exit 3"})
    # The command failed and the cell ran, which are two different facts, and
    # the agent is told both rather than left to read one as the other.
    assert answer["cell"]["ok"] is True
    assert "ended with status 3" in answer["text"]


def test_a_cell_that_raised_comes_back_as_a_failed_call_carrying_the_traceback(mcp: Calling):
    answer = mcp.call("run_python", {"code": "raise ValueError('no such column')"})
    assert answer["isError"] is True
    assert "no such column" in answer["text"]
    assert answer["cell"]["ok"] is False


GIVEN = "the word this session was given"


def _said(path: str, greeting: dict[str, Any]) -> dict[str, Any]:
    """Opens one connection, says which kernel it is for, and reads the answer.

    Deliberately a raw socket rather than the relay: what is under test is
    what this host does with a greeting it did not write, which is exactly the
    shape anything else on the machine could send.
    """
    talking = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    talking.settimeout(10.0)
    talking.connect(path)
    try:
        talking.sendall((json.dumps(greeting) + "\n").encode("utf-8"))
        return json.loads(talking.makefile("r", encoding="utf-8").readline())
    finally:
        talking.close()


@pytest.fixture
def short_dir() -> Iterator[str]:
    """Somewhere with room for a socket's name.

    A unix socket's name lives in a fixed-size field, and pytest's own
    temporary directories are already most of it.
    """
    made = tempfile.mkdtemp()
    try:
        yield made
    finally:
        shutil.rmtree(made, ignore_errors=True)


@pytest.fixture
def listening(registry: Registry, short_dir: str) -> Iterator[str]:
    """A socket bound for one Task, with one session configured for it."""
    workspace = os.path.join(short_dir, "task")
    os.mkdir(workspace)
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=workspace,
        environment="python",
        prefix=["/usr/bin/env"],
        token=GIVEN,
    )
    endpoints = Endpoints(registry)
    path = os.path.join(short_dir, "host.sock")
    endpoints.listen(path, workspace)
    try:
        yield path
    finally:
        endpoints.close()


def _greeting(**named: str) -> dict[str, str]:
    return {"session": "se_1", "task": "tk_1", "name": "main", "agent": "claude", **named}


def test_a_connection_naming_a_session_this_host_never_heard_of_gets_nowhere(listening: str):
    refused = _said(listening, _greeting(session="se_9", token=GIVEN))
    assert "se_9" in refused["error"]["message"]


def test_naming_a_session_is_not_the_same_as_having_been_given_it(listening: str):
    # One socket answers for every session of its Task, so anything inside the
    # boundary can name a session that is not its own. What it cannot do is
    # hold the word this machine wrote into that session's own relay.
    refused = _said(listening, _greeting(token="a word this connection made up"))
    assert "was not the one given se_1's kernels" in refused["error"]["message"]

    silent = _said(listening, _greeting())
    assert "was not the one given se_1's kernels" in silent["error"]["message"]


def test_a_session_nothing_minted_a_word_for_reaches_no_kernels(
    registry: Registry, short_dir: str
):
    workspace = os.path.join(short_dir, "task")
    os.mkdir(workspace)
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=workspace,
        environment="python",
        prefix=["/usr/bin/env"],
    )
    endpoints = Endpoints(registry)
    path = os.path.join(short_dir, "host.sock")
    endpoints.listen(path, workspace)
    try:
        refused = _said(path, _greeting(token="anything at all"))
    finally:
        endpoints.close()
    assert "was not the one given se_1's kernels" in refused["error"]["message"]


def test_one_task_cannot_spend_the_connections_every_other_task_needs(listening: str):
    # This process holds every Task's kernels, so a connection past the bound
    # is turned away rather than given a thread out of what the rest of the
    # machine is running on.
    held = []
    try:
        for _ in range(MOST_CONNECTIONS):
            talking = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            talking.settimeout(10.0)
            talking.connect(listening)
            talking.sendall((json.dumps(_greeting(token=GIVEN)) + "\n").encode("utf-8"))
            assert json.loads(talking.makefile("r", encoding="utf-8").readline())["ready"] is True
            held.append(talking)
        refused = _said(listening, _greeting(token=GIVEN))
    finally:
        for talking in held:
            talking.close()
    assert f"already answering {MOST_CONNECTIONS} connections" in refused["error"]["message"]


def test_this_package_reaches_for_nothing_it_does_not_declare():
    """Every distribution this package's own code imports is one it asks for.

    A transitive dependency is on disk and imports cleanly, which is exactly
    what makes reaching for one a mistake nothing notices: the day the package
    that pulled it in stops doing so, this one fails to start on a machine
    where nothing changed.
    """
    declared = {"mcp"}
    source = Path(__file__).resolve().parent.parent / "src"
    reached: set[str] = set()
    for path in source.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                reached.update(name.name.split(".")[0] for name in node.names)
            # A relative import has no module of its own to name.
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                reached.add(node.module.split(".")[0])
    assert reached - declared - set(sys.stdlib_module_names) == set()


def test_an_opening_line_that_never_ends_is_refused_rather_than_read():
    # Asserted on the reading itself rather than over a socket, because what
    # is under test is how much was read: a connection sending this over a
    # socket has already been refused and disconnected by the time the rest of
    # it is written, which proves the refusal but not the bound.
    saying = io.StringIO("{" + "a" * (GREETING_BYTES * 4))
    with pytest.raises(ValueError, match="never ended"):
        opening_line(saying)
    assert saying.tell() <= GREETING_BYTES


def test_a_connection_cannot_reach_a_session_confined_for_another_task(
    listening: str, registry: Registry, short_dir: str
):
    # A second Task's session, configured on the same host. Its kernels are
    # not this socket's to hand out: the socket sits inside one Task's
    # directory, and that is the claim the greeting is checked against.
    elsewhere = os.path.join(short_dir, "another")
    os.mkdir(elsewhere)
    registry.configure_session(
        session_id="se_2",
        task_id="tk_2",
        workspace=elsewhere,
        environment="python",
        prefix=["/usr/bin/env"],
    )
    refused = _said(listening, {"session": "se_2", "task": "tk_2", "name": "main", "agent": "claude", "token": GIVEN})
    assert "not a session of the Task this socket belongs to" in refused["error"]["message"]


def test_a_socket_goes_when_the_host_that_bound_it_does(registry: Registry, short_dir: str):
    path = os.path.join(short_dir, "host.sock")
    endpoints = Endpoints(registry)
    endpoints.listen(path, short_dir)
    assert os.path.exists(path)
    endpoints.close()
    # A socket file left behind is one the next relay connects to and waits on
    # forever, since nothing is listening behind it.
    assert not os.path.exists(path)


def test_a_name_too_long_for_a_socket_is_refused_in_words(registry: Registry, short_dir: str):
    endpoints = Endpoints(registry)
    too_long = os.path.join(short_dir, "d" * 120, "host.sock")
    with pytest.raises(ValueError, match="room for fewer than"):
        endpoints.listen(too_long, short_dir)
