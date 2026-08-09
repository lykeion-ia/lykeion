"""The two tools this machine publishes, and the kernel they run in.

Both are bound to one `Reach` when the server is built — the kernel, and who
is running the cell — so neither tool takes a kernel as an argument. That is
the whole of what keeps an agent inside the namespace it was given: there is
no field on either tool that names one.

A tool answers with the cell, twice over. The structured half is the record
the lab keeps; the text half is what the agent reads, which is the cell's own
output and nothing about how it was run.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import asyncio
import mcp.types as types
from mcp.server.lowlevel import Server

from ..kernels import KernelIdentity
from ..registry import Registry

# What a shell command is run by. Named here so the one place a command
# becomes a program is visible: it is an argument list, and the shell is the
# program in it rather than a mode something else was spawned in.
SHELL = "/bin/sh"


@dataclass(frozen=True)
class Reach:
    """One kernel, and who is reaching it.

    Everything a tool needs beyond the code itself, decided by the daemon and
    fixed before the agent's first message is read.
    """

    registry: Registry
    identity: KernelIdentity
    agent: str


def shell_source(command: str) -> str:
    """The cell that runs one shell command inside the kernel's boundary.

    Its output is captured and printed rather than left to the command's own
    descriptors: a kernel answers its host down the same pipe it was started
    with, and a child writing there directly would put its output where the
    answer to this cell was meant to be.

    The names it binds are given back before the cell ends, so a researcher's
    own `_` and their own `subprocess` survive a tool call they did not make.
    """
    return (
        "import subprocess as _lykeion_run, sys as _lykeion_streams\n"
        f"_lykeion_ran = _lykeion_run.run({[SHELL, '-c', command]!r},"
        " capture_output=True, text=True)\n"
        "print(_lykeion_ran.stdout, end='')\n"
        "print(_lykeion_ran.stderr, end='', file=_lykeion_streams.stderr)\n"
        # Said out loud, because a command that failed and a command that
        # printed nothing are otherwise the same silence. The cell itself ran
        # either way, which is a different fact and is reported separately.
        "if _lykeion_ran.returncode:\n"
        "    print(f'this command ended with status {_lykeion_ran.returncode}',"
        " file=_lykeion_streams.stderr)\n"
        "del _lykeion_run, _lykeion_streams, _lykeion_ran\n"
    )


def _read(cell: dict[str, Any]) -> str:
    """What the agent reads back: the cell's own output, in the order it was
    produced.

    A cell that produced nothing reads as nothing rather than as an empty
    answer dressed up — the agent has the structured half if it needs to know
    that the cell ran at all.
    """
    parts: list[str] = []
    for output in cell.get("outputs", []):
        kind = output.get("kind")
        if kind == "stream":
            parts.append(str(output.get("text", "")))
        elif kind == "execute_result":
            parts.append(str(output.get("data", {}).get("text/plain", "")))
        elif kind == "error":
            parts.append("\n".join(output.get("traceback", [])))
    return "".join(parts)


def _answer(cell: dict[str, Any]) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=_read(cell))],
        structuredContent={"cell": cell},
        # A cell that raised is a failed tool call. The output still travels:
        # a traceback is what the agent needs in order to write the next cell.
        isError=not cell.get("ok", False),
    )


TOOLS = [
    types.Tool(
        name="run_python",
        title="Run Python",
        description=(
            "Run Python in this Task's kernel. The namespace is held open between "
            "calls, so a name bound by one call is still bound in the next."
        ),
        inputSchema={
            "type": "object",
            "properties": {"code": {"type": "string", "description": "The Python to run."}},
            "required": ["code"],
        },
    ),
    types.Tool(
        name="run_shell",
        title="Run a shell command",
        description=(
            "Run one shell command inside the same boundary as this Task's kernel, "
            "in the Task's own directory. Its output comes back as the cell's output."
        ),
        inputSchema={
            "type": "object",
            "properties": {"command": {"type": "string", "description": "The command to run."}},
            "required": ["command"],
        },
    ),
]


def _text(arguments: dict[str, Any] | None, key: str) -> str:
    value = (arguments or {}).get(key)
    if not isinstance(value, str):
        raise ValueError(f"this tool needs a {key}")
    return value


def cell_for(reach: Reach, source: str) -> dict[str, Any]:
    """One cell, run in the kernel this server is bound to."""
    return reach.registry.execute(
        reach.identity,
        source,
        origin={"surface": "agent", "by": reach.agent},
    )


def server_for(reach: Reach) -> Server[Any]:
    """The MCP server one connection is answered by."""

    async def on_list_tools(
        _ctx: Any, _params: types.PaginatedRequestParams | None
    ) -> types.ListToolsResult:
        return types.ListToolsResult(tools=TOOLS)

    async def on_call_tool(
        _ctx: Any, params: types.CallToolRequestParams
    ) -> types.CallToolResult:
        # Off the loop, because a cell holds whatever is running it for as
        # long as it runs. Run here, this connection could not answer a ping
        # or a cancellation for the length of a researcher's slowest cell.
        if params.name == "run_python":
            source = _text(params.arguments, "code")
        elif params.name == "run_shell":
            source = shell_source(_text(params.arguments, "command"))
        else:
            raise ValueError(f"this machine publishes no tool named {params.name}")
        return _answer(await asyncio.to_thread(cell_for, reach, source))

    return Server(
        "lykeion",
        version="1",
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
