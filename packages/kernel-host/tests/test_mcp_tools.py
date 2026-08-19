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
import venv
from pathlib import Path
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Iterator, NamedTuple

import anyio
import anyio.from_thread
import pytest
from mcp.client.session import ClientSession
from mcp.shared.exceptions import MCPError
from mcp.shared.memory import create_client_server_memory_streams

from lykeion_kernel.kernels import KernelIdentity
from lykeion_kernel.mcp.endpoint import (
    Endpoints,
    GREETING_BYTES,
    MOST_CONNECTIONS,
    _greeting as opening_line,
)
from lykeion_kernel.mcp.server import Reach, server_for, tools_for
from lykeion_kernel.registry import LAUNCHERS, Registry


def python_environment() -> list[dict[str, Any]]:
    """One Python environment, the shape `configure_session` takes on the
    wire — named and defaulted, so a cell naming none still reaches it."""
    return [
        {
            "language": "python",
            "name": "python",
            "interpreter": sys.executable,
            "prefix": ["/usr/bin/env"],
            "default": True,
        }
    ]


def built_environment(work_dir: Path, name: str) -> dict[str, Any]:
    """A second Python environment, really built where this machine builds one.

    `<workDir>/envs/<name>`, entered through the `bin/python3` the daemon's own
    `readEnvStatus` probes before it will call a build ready — the same shape
    `uv venv` leaves behind, made here with the standard library so a test can
    build one without a network or a package index.

    A real interpreter and not a path spelled to look like one. What the first
    test asserts is the prefix a cell reports about itself, and that assertion
    is only worth making against an interpreter that genuinely lives there.
    """
    built = work_dir / "envs" / name
    venv.create(str(built), with_pip=False, symlinks=True)
    return {
        "language": "python",
        "name": name,
        "interpreter": str(built / "bin" / "python3"),
        "prefix": ["/usr/bin/env"],
    }


class Calling(NamedTuple):
    """One agent's end of a live MCP session."""

    call: Any
    tools: Any


@asynccontextmanager
async def _session(reach: Reach, *, raise_exceptions: bool = True):
    server = server_for(reach)
    async with create_client_server_memory_streams() as (client, serving):
        async with anyio.create_task_group() as answering:

            async def run() -> None:
                await server.run(
                    serving[0], serving[1], server.create_initialization_options(),
                    raise_exceptions=raise_exceptions,
                )

            answering.start_soon(run)
            async with ClientSession(client[0], client[1]) as session:
                await session.initialize()
                yield session
            answering.cancel_scope.cancel()


def _talking(reach: Reach, *, raise_exceptions: bool = True) -> Iterator[Calling]:
    """One agent's end of a session already configured for it.

    A generator rather than a fixture of its own, because more than one
    fixture below hands out the same end of the same conversation and differs
    only in what the session was configured with.

    `raise_exceptions` is the SDK's own knob and it decides which of two
    shapes a refusal arrives in. Most refusals here are `CallToolResult`s with
    `isError` set, built by `_refused` — but a guard that RAISES out of
    `on_call_tool` (`_text`'s, and the unpublished-tool-name one) becomes a
    JSON-RPC error instead, which the client re-raises. `True` re-raises it
    out of the server as well, which is what makes a real crash legible in
    the tests that predate this parameter; `False` is what an endpoint
    actually runs (`endpoint.py` passes no flag at all), so it is what a test
    about how an agent experiences a malformed argument has to use. Refusals
    that arrive that way are normalised below into the same dict the
    `isError` ones produce, since to an agent they are the same event: the
    call was refused and nothing ran.
    """
    with anyio.from_thread.start_blocking_portal() as portal:
        with portal.wrap_async_context_manager(
            _session(reach, raise_exceptions=raise_exceptions)
        ) as session:

            def call(
                name: str,
                arguments: dict[str, Any],
                meta: dict[str, Any] | None = None,
            ) -> dict[str, Any]:
                try:
                    answer = portal.call(
                        functools.partial(session.call_tool, name, arguments, meta=meta)
                    )
                except MCPError as refused:
                    # Only where the server was asked to answer its own
                    # exceptions rather than raise them. Under `True` this is
                    # a crash and stays one.
                    if raise_exceptions:
                        raise
                    return {
                        "structured": None,
                        "cell": None,
                        "text": str(refused),
                        "isError": True,
                    }
                return {
                    # The structured half whole, for the tools that answer
                    # with something other than a cell. `cell` below is the
                    # same object read one key in, kept as its own entry
                    # because every test that predates a second shape reads
                    # it and because "no cell" is a claim worth making
                    # separately from "no structured half at all".
                    "structured": answer.structured_content,
                    # Absent on a call that was refused before anything ran:
                    # a refusal mints no kernel, so there is no cell for the
                    # lab to keep and none for a test to read. The cost of
                    # answering that with None rather than a KeyError is that
                    # a test reading only `text` and `isError` can no longer
                    # notice a structured half gone missing from a call that
                    # did run — which is why the refusal tests assert
                    # `cell is None` outright, making "no cell" a claim some
                    # test makes rather than a silence every test tolerates.
                    "cell": (answer.structured_content or {}).get("cell"),
                    "text": "".join(
                        block.text for block in answer.content if block.type == "text"
                    ),
                    "isError": bool(answer.is_error),
                }

            yield Calling(call=call, tools=lambda: portal.call(session.list_tools))


# `_talking` as a context manager, for a test that builds its own session
# rather than taking one from a fixture. The fixtures `yield from` it, which
# is what closes it; a test that merely iterated it would leave the portal and
# the server task to a garbage collector.
_conversation = contextmanager(_talking)


def _agent_reaching(registry: Registry) -> Reach:
    """The kernel one connection may address, the way the endpoint builds one."""
    return Reach(
        registry=registry,
        identity=KernelIdentity(
            session_id="se_1", task_id="tk_1", name="main",
            language="python", environment="python",
        ),
        agent="claude",
    )


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
        environments=python_environment(),
    )
    yield from _talking(_agent_reaching(registry))


@pytest.fixture
def host_with_two_envs(registry: Registry, tmp_path) -> Iterator[Calling]:
    """An agent whose session has two Python environments rather than one.

    `Confinement.environments` is keyed by language and name together, so a
    session holding two Python environments genuinely holds two, and the
    session's default is the one a cell that names none still reaches. The
    second is built on disk, so a cell that says which one it ran in can be
    believed rather than taken on the wiring's word.

    `declared` names both, which is what makes the third of `identity_for`'s
    three refusals the one an unknown name earns here: this lab declared
    these two and nothing else.
    """
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=python_environment() + [built_environment(tmp_path, "crispr")],
        declared=["python", "crispr"],
    )
    yield from _talking(_agent_reaching(registry))


@pytest.fixture
def host_with_an_unbuilt_env(registry: Registry, tmp_path) -> Iterator[Calling]:
    """A session whose lab declared an environment this machine has not built.

    The row `host_with_two_envs` cannot hold: both of its names are built
    here, so an answer that simply reported what this machine holds would be
    indistinguishable there from one that read the lab's declarations too.
    `atacseq` is declared and has nothing on disk — which is the state a
    colleague's environment is in on every machine except theirs.
    """
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=python_environment() + [built_environment(tmp_path, "crispr")],
        declared=["python", "crispr", "atacseq"],
    )
    yield from _talking(_agent_reaching(registry))


def stdout_of(answer: dict[str, Any]) -> str:
    """Everything the cell wrote to its own standard output."""
    return "".join(
        output.get("text", "")
        for output in answer["cell"]["outputs"]
        if output.get("kind") == "stream" and output.get("name") == "stdout"
    )


def test_execute_python_cell_lands_in_the_kernel_named_by_the_bridge(mcp: Calling):
    mcp.call("execute_python_cell", {"code": "y = 7"})
    assert "7" in stdout_of(mcp.call("execute_python_cell", {"code": "print(y)"}))


def test_a_tool_call_carries_its_identity_into_the_cell(mcp: Calling):
    cell = mcp.call("execute_python_cell", {"code": "1"})["cell"]
    assert cell["name"] == "main"
    assert cell["origin"] == {"surface": "agent", "by": "claude"}


def test_a_call_whose_meta_names_its_tool_use_id_leaves_it_on_the_cell(mcp: Calling):
    # Claude Code forwards the id its own transcript keeps for the call, under
    # a vendor key. The cell keeps it, so the notebook record and the agent's
    # execution log name the same event.
    cell = mcp.call(
        "execute_python_cell", {"code": "1"}, meta={"claudecode/toolUseId": "toolu_01x"}
    )["cell"]
    assert cell["toolUseId"] == "toolu_01x"


def test_a_shell_call_carries_its_tool_use_id_the_same_way(mcp: Calling):
    cell = mcp.call(
        "execute_shell_cell", {"command": "true"}, meta={"toolUseId": "exec-4f"}
    )["cell"]
    assert cell["toolUseId"] == "exec-4f"


def test_a_call_with_no_meta_leaves_the_cell_without_a_tool_use_id(mcp: Calling):
    # Absent rather than null: a provider that forwarded nothing said nothing,
    # and the daemon may still join the cell to its step by observation.
    cell = mcp.call("execute_python_cell", {"code": "1"})["cell"]
    assert "toolUseId" not in cell


def test_both_calls_reach_the_same_kernel(mcp: Calling):
    # The kernel is decided when the server is built and cannot be named by a
    # tool call, so two calls that could not have said which kernel they meant
    # are in one namespace whether or not they say so.
    first = mcp.call("execute_python_cell", {"code": "1"})["cell"]
    second = mcp.call("execute_shell_cell", {"command": "true"})["cell"]
    assert first["kernelId"] == second["kernelId"]


def test_a_tool_names_nothing_a_caller_could_point_at_another_kernel(
    mcp: Calling, registry: Registry
):
    published = {tool.name: tool.input_schema for tool in mcp.tools().tools}
    # The shell tool, the two tools that answer about environments rather than
    # running anything, and one runner per language this host has a launcher
    # for AT ALL — capability in principle, not this machine's own discovered
    # runnables, so every machine running this code publishes the same five.
    expected = ["execute_shell_cell", "manage_environments", "manage_packages"] + [
        f"execute_{language}_cell" for language in registry.capable_languages
    ]
    assert sorted(published) == sorted(expected)
    # `environment` is the one thing a call may say about where it lands, and
    # it names an environment of THIS session — resolved through this
    # session's own confinement, against the identity the connection was
    # built with. The session, the Task and the kernel's own name are still
    # nowhere on any tool, which is what keeps a call inside the namespaces
    # it was given.
    # Membership and not order: which properties a tool offers is the claim,
    # and the order they are written in a schema means nothing to a caller.
    assert sorted(published["execute_python_cell"]["properties"]) == ["code", "environment"]
    assert sorted(published["execute_shell_cell"]["properties"]) == ["command", "environment"]
    # Named, never required: a cell that says nothing runs where it always did.
    assert published["execute_python_cell"]["required"] == ["code"]
    assert published["execute_shell_cell"]["required"] == ["command"]


def test_the_r_tool_publishes_an_environment_and_runs_the_cell_there(
    mcp: Calling, registry: Registry, tmp_path
):
    """The R tool offers an `environment`, and a cell that names one lands in it.

    This asserts the inverse of what it used to. While the provisioner built
    Python environments alone, an `environment` on the R tool would have
    published an argument whose every value could only ever be refused. It
    builds R ones now, so the argument is real and its absence would be the
    defect: D9's identity carries an environment axis, and a language that
    cannot address it can reach only one environment ever.

    Both halves are asserted, and the schema is the lesser one. Nothing
    between an agent and the handler checks arguments against a schema —
    `addressable` is DERIVED from the published properties, and it is that
    derivation, not the schema entry, that decides whether the argument is
    read at all. A schema saying yes over a handler that ignores it is the
    exact shape this test was written to catch, in the other direction.

    The second R environment is what makes the difference visible: against a
    session holding one, an argument being honoured is indistinguishable from
    an argument being ignored.
    """
    # `execute_r_cell` is published unconditionally (`capable_languages`, not
    # machine discovery) — what this test still needs from the machine is a
    # real Rscript to hand this session's confinement, so an actual R process
    # answers the call below. `runnables()` never discovers one any more
    # (Task 6), so this asks the machine directly rather than through it.
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("this machine has no Rscript, so it holds no R kernels")
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=python_environment()
        + [
            {"language": "r", "name": "r", "interpreter": rscript, "prefix": ["/usr/bin/env"], "default": True},
            {"language": "r", "name": "bioc", "interpreter": rscript, "prefix": ["/usr/bin/env"]},
        ],
        declared=["python", "r", "bioc"],
    )
    published = {tool.name: tool.input_schema for tool in mcp.tools().tools}
    assert "environment" in published["execute_r_cell"]["properties"]
    # Optional, like every other tool that takes one: a cell that names none
    # runs in this Task's default rather than being refused for not choosing.
    assert published["execute_r_cell"]["required"] == ["code"]

    answer = mcp.call("execute_r_cell", {"code": "1 + 1", "environment": "bioc"})

    # It ran, and it ran where it was sent — not in this session's R default,
    # which is what an ignored argument would have produced.
    assert answer["cell"]["ok"] is True
    assert answer["cell"]["environment"] == "bioc"


def test_an_r_cell_whose_environment_is_unreachable_is_refused_by_that_value(
    mcp: Calling, registry: Registry, tmp_path
):
    """The other half of the promise the published description makes.

    "An environment that does not exist is refused by name rather than run
    somewhere else" is now on the R tool too, and a promise a tool makes in
    its own description is a thing to test rather than to trust. Neither an
    unknown name nor a value that is not a name at all may fall back to the
    default.

    No Rscript is needed and none is used: both refusals happen while
    resolving the identity, before a kernel is minted, which is the property
    being pinned as much as the sentence is.
    """
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=python_environment()
        + [
            {"language": "r", "name": "r", "interpreter": "/nonexistent/bin/Rscript",
             "prefix": ["/usr/bin/env"], "default": True},
        ],
        declared=["python", "r"],
    )
    before = len(registry.list())

    unknown = mcp.call("execute_r_cell", {"code": "1", "environment": "nosuch"})
    assert unknown["isError"] is True
    assert "nosuch" in unknown["text"]
    assert unknown["cell"] is None

    not_a_name = mcp.call("execute_r_cell", {"code": "1", "environment": 7})
    assert not_a_name["isError"] is True
    assert "7" in not_a_name["text"]
    assert not_a_name["cell"] is None

    # Neither refusal left an entry behind for a kernel that never started.
    assert len(registry.list()) == before


def test_a_machine_with_no_r_publishes_no_way_to_run_it():
    from lykeion_kernel.mcp.server import tools_for

    assert [tool.name for tool in tools_for(("python",))] == [
        "execute_python_cell",
        "execute_shell_cell",
        # Published whatever this machine can run: a session holds
        # environments whether or not this machine holds an R kernel, and
        # asking what they are runs nothing.
        "manage_environments",
        # And the same for changing what one holds: a declaration is the
        # lab's (D2), so adding to one is not a question about this disk.
        "manage_packages",
    ]
    assert [tool.name for tool in tools_for(("python", "r"))] == [
        "execute_python_cell",
        "execute_r_cell",
        "execute_shell_cell",
        "manage_environments",
        "manage_packages",
    ]


def test_calling_the_r_tool_resolves_rs_own_environment_not_pythons(
    mcp: Calling, registry: Registry, tmp_path
):
    """`on_call_tool` swaps a call's language onto the connection's own
    identity; naively carrying the OLD language's environment over with it
    would hand an R cell Python's environment name, which this session never
    declared an R environment under — refused as unconfined rather than
    started. This is exactly the failure the daemon's own
    `bridge.test.ts` caught end to end; this is the fast version of it.
    """
    # `execute_r_cell` is published unconditionally now (`capable_languages`,
    # not machine discovery) — what this test still needs from the machine is
    # a real Rscript to hand this session's confinement, so an actual R
    # process is what answers the call below. `runnables()` never discovers
    # one any more (Task 6), so this asks the machine directly rather than
    # through it.
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("this machine has no Rscript, so it holds no R kernels")
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=python_environment()
        + [{"language": "r", "name": "r", "interpreter": rscript, "prefix": ["/usr/bin/env"], "default": True}],
    )

    cell = mcp.call("execute_r_cell", {"code": "1 + 1"})["cell"]

    assert cell["ok"] is True
    assert cell["language"] == "r"
    assert cell["environment"] == "r"


def test_a_cell_runs_in_the_environment_it_names(host_with_two_envs: Calling):
    """A cell that names one of its session's environments lands in it, and
    not in the default the connection was built with.

    Asserted on the prefix the interpreter reports about itself, which is the
    one thing nothing on this side of the pipe can arrange: the cell is
    running under `<workDir>/envs/crispr/bin/python3` or it is not.
    """
    answer = host_with_two_envs.call(
        "execute_python_cell",
        {"code": "import sys; print(sys.prefix)", "environment": "crispr"},
    )
    assert "/envs/crispr" in stdout_of(answer)
    # And the record the lab keeps names it too, so a notebook read back says
    # which environment produced this output rather than leaving it to be
    # inferred from the output itself.
    assert answer["cell"]["environment"] == "crispr"


def test_a_shell_cell_runs_in_the_environment_it_names_too(host_with_two_envs: Calling):
    # The shell tool resolves its identity through the same call, so this is
    # the branch where the language is decided for the caller rather than by
    # the tool's own name — a cell whose environment was resolved only on the
    # other branch would land in the default here and say nothing about it.
    answer = host_with_two_envs.call(
        "execute_shell_cell", {"command": "true", "environment": "crispr"}
    )
    assert answer["cell"]["ok"] is True
    assert answer["cell"]["environment"] == "crispr"


def test_a_cell_naming_an_unknown_environment_mints_no_kernel(
    host_with_two_envs: Calling, registry: Registry
):
    # One cell that really ran first, so `before` is not zero: counted from an
    # empty registry, "mints nothing" is only "the count did not go up from
    # nothing", which a registry that never lists anything would pass just as
    # well as a refusal that costs nothing.
    #
    # And run in `crispr` rather than in the default, so the entry already
    # sitting there is not the one a refusal quietly falling back to the
    # default would mint. Started from the default's own kernel, that
    # fall-back would land in the entry that was already there and the count
    # would not move; started from `crispr`, it mints a second and the count
    # says so on its own rather than leaning on the assertion above it to fail
    # first.
    host_with_two_envs.call(
        "execute_python_cell", {"code": "1", "environment": "crispr"}
    )
    before = len(registry.list())
    assert before > 0

    answer = host_with_two_envs.call(
        "execute_python_cell", {"code": "1", "environment": "nonesuch"}
    )
    assert answer["isError"] is True
    # Refused by the name it asked for, so the agent can tell a typo from a
    # colleague's environment it has not built yet — `identity_for` has a
    # sentence for each of those, and every one of them carries the name.
    assert "nonesuch" in answer["text"]
    # And no structured half, because nothing ran: a refusal is not a cell the
    # lab keeps, and an empty one invented here would be a record of work that
    # never happened. This is also what pins `_talking`'s `or {}` — the one
    # call shape that legitimately has no cell is asserted to be this one.
    assert answer["cell"] is None
    # A refused call mints nothing. An environment resolved before a place is
    # taken is the whole reason there is no kernel here to list: a name this
    # session cannot reach must not leave an entry on a researcher's machine
    # for a kernel that was never going to start.
    assert len(registry.list()) == before


def test_a_cell_whose_environment_is_not_a_name_is_refused_by_the_value(
    host_with_two_envs: Calling,
):
    # Not quietly answered with the default: the published description promises
    # that an environment which does not exist is refused by name rather than
    # run somewhere else, and a value that is not a name at all must not be the
    # one exception to it. The refusal says which value it was, because the
    # agent wrote it and is the one who has to write the next call.
    answer = host_with_two_envs.call(
        "execute_python_cell", {"code": "1", "environment": 3}
    )
    assert answer["isError"] is True
    assert "3" in answer["text"]
    assert answer["cell"] is None


def test_a_cell_naming_no_environment_still_runs_where_it_always_did(
    host_with_two_envs: Calling
):
    # The argument is published and not required. A session with a second
    # environment on it must not move the cells that say nothing.
    answer = host_with_two_envs.call("execute_python_cell", {"code": "1"})
    assert answer["cell"]["environment"] == "python"
    assert "/envs/crispr" not in stdout_of(
        host_with_two_envs.call("execute_python_cell", {"code": "import sys; print(sys.prefix)"})
    )


def test_a_shell_cell_finds_the_python_of_the_environment_it_is_in(
    host_with_two_envs: Calling, tmp_path
):
    """A bare `python3` in a shell cell is the environment's own.

    The whole point of naming an environment is that `pip install` in that
    cell installs there. A shell whose PATH still began with the kernel
    host's own `bin` would resolve `python3`, `pip` and `uv` to Lykeion's
    installation while the cell reported it ran in `crispr`.

    Both halves are observed inside the cell: which file the shell resolves
    the name to, and what that file says its own prefix is once it runs.
    """
    answer = host_with_two_envs.call(
        "execute_shell_cell",
        {
            "command": "command -v python3; python3 -c 'import sys; print(sys.prefix)'",
            "environment": "crispr",
        },
    )
    found, prefix = stdout_of(answer).splitlines()
    assert found == str(tmp_path / "envs" / "crispr" / "bin" / "python3")
    assert prefix == found.rsplit("/bin/", 1)[0]


def test_a_python_cell_tells_its_tools_the_environment_it_is_actually_in(
    host_with_two_envs: Calling, monkeypatch
):
    """`VIRTUAL_ENV` inside a Python cell names the cell's own environment.

    A cell's `sys.executable` being right is not enough: `pip`, `uv` and
    anything a researcher shells out to read `VIRTUAL_ENV` and act on it, so
    a cell in `crispr` holding the host's venv there installs into Lykeion's
    own installation and reports success.

    The host is given the `VIRTUAL_ENV` a daemon started from an activated
    virtualenv has — which is how this was found — so what the cell sees is
    a value that had to be replaced rather than one that happened to be
    absent on the machine running the suite.
    """
    monkeypatch.setenv("VIRTUAL_ENV", sys.prefix)

    answer = host_with_two_envs.call(
        "execute_python_cell",
        {
            "code": "import os, sys\nprint(os.environ.get('VIRTUAL_ENV', '<none>'))\nprint(sys.prefix)",
            "environment": "crispr",
        },
    )

    named, running_in = stdout_of(answer).splitlines()
    # What the cell tells its tools and what its own interpreter is are the
    # same environment — both read out of the cell, so neither can be the
    # value this test handed the launch.
    assert named == running_in
    assert named.endswith("/envs/crispr")


def test_a_cell_naming_no_environment_still_reaches_the_hosts_own_python(
    host_with_two_envs: Calling
):
    """The compatibility claim the whole change rests on, observed.

    For the default environment the interpreter IS the kernel host's own, so
    a cell that names nothing must come out exactly where it always did: the
    same prefix, a bare `python3` that is that prefix's, the packages the
    host was installed with still importable, and a `VIRTUAL_ENV` naming the
    same venv it named before.

    The `VIRTUAL_ENV` half is a claim about CONTINUITY, and continuity is
    only observable while the host's inherited `VIRTUAL_ENV` and its own
    `sys.prefix` agree — which under the production launch (`uv run
    --project`) they do. On a host where they disagree, a default cell's
    `VIRTUAL_ENV` really is replaced or newly created by this change, and
    asserting the new rule there would report success for a case in which
    the compatibility claim is false. So the precondition is asserted rather
    than assumed: the day a host breaks it, this says so instead of quietly
    narrowing to something weaker.
    """
    assert os.environ.get("VIRTUAL_ENV") in (None, sys.prefix)

    answer = host_with_two_envs.call(
        "execute_python_cell",
        {
            "code": (
                "import os, shutil, sys\n"
                "print(sys.prefix)\n"
                "print(shutil.which('python3'))\n"
                "print(os.environ.get('VIRTUAL_ENV', '<none>'))\n"
                "import mcp\n"
                "print('the packages this host was installed with')\n"
            )
        },
    )

    prefix, found, named, imported = stdout_of(answer).splitlines()
    assert prefix == sys.prefix
    assert found == str(Path(sys.executable).parent / "python3")
    # The kernel host runs out of its own virtualenv under `uv run`, which is
    # what this suite is started with; a host installed outside one would get
    # no VIRTUAL_ENV rather than an inherited stranger's.
    assert named == (sys.prefix if (Path(sys.prefix) / "pyvenv.cfg").exists() else "<none>")
    assert imported == "the packages this host was installed with"


def test_the_environments_tool_names_what_exists_and_marks_what_is_built_here(
    host_with_an_unbuilt_env: Calling,
):
    """What an agent asking "what environments are there" gets back.

    Both halves in one answer: every name this lab declared, and which of them
    this machine can actually start a kernel in. The declared-but-unbuilt row
    is the one that matters — an agent that can see it can offer to build it
    rather than telling a researcher their colleague's environment does not
    exist.
    """
    answer = host_with_an_unbuilt_env.call("manage_environments", {"action": "list"})

    assert answer["isError"] is False
    listed = answer["structured"]
    assert listed["declarationsKnown"] is True
    by_name = {row["name"]: row for row in listed["environments"]}
    assert sorted(by_name) == ["atacseq", "crispr", "python"]
    assert by_name["python"]["builtHere"] is True
    assert by_name["crispr"]["builtHere"] is True
    # Declared and absent from this machine: named, and not marked built.
    assert by_name["atacseq"]["builtHere"] is False
    # And the agent's own half says which is which without it having to read
    # the structured one.
    assert "atacseq — declared by this lab, not built on this machine" in answer["text"]
    assert "crispr (python) — built on this machine" in answer["text"]


def test_an_environment_the_tool_calls_unbuilt_is_one_no_cell_can_reach(
    host_with_an_unbuilt_env: Calling,
):
    """The mark means what a cell would find, which is the only thing that
    makes it worth reporting.

    Every name is read back out of the tool's own answer rather than out of
    the fixture, so what is checked is what the tool decided: each name it
    called built runs and says it ran there, and each name it did not is
    refused by the sentence a declared-but-unbuilt environment earns.
    """
    listed = host_with_an_unbuilt_env.call(
        "manage_environments", {"action": "list"}
    )["structured"]["environments"]
    built = [row["name"] for row in listed if row["builtHere"]]
    unbuilt = [row["name"] for row in listed if not row["builtHere"]]
    # Both halves are exercised below, so an answer that marked everything one
    # way cannot pass this by leaving a loop with nothing to iterate.
    assert built and unbuilt

    for name in built:
        ran = host_with_an_unbuilt_env.call(
            "execute_python_cell", {"code": "1", "environment": name}
        )
        assert ran["cell"]["ok"] is True
        assert ran["cell"]["environment"] == name
    for name in unbuilt:
        refused = host_with_an_unbuilt_env.call(
            "execute_python_cell", {"code": "1", "environment": name}
        )
        assert refused["isError"] is True
        assert refused["cell"] is None
        assert f"the environment {name} is not built on this machine yet" == refused["text"]


def test_the_environments_tool_publishes_two_actions_and_refuses_every_other(
    host_with_an_unbuilt_env: Calling,
):
    """`create` and `list` are the whole of what this tool does, and the
    schema says so.

    Nothing between a model and the handler checks an argument against a
    schema, so an action this tool never published arrives looking exactly
    like the one it did. `delete` is refused because D7 says an environment
    is gigabytes on a colleague's laptop and removing one is not a thing to
    do by conversational inference — and it is refused HERE, because a
    handler that acted on whatever arrived would be a working capability
    behind a surface this machine never published.
    """
    schema = {tool.name: tool.input_schema for tool in host_with_an_unbuilt_env.tools().tools}[
        "manage_environments"
    ]
    assert schema["properties"]["action"]["enum"] == ["create", "list"]

    for asked in ("delete", "rename"):
        answer = host_with_an_unbuilt_env.call("manage_environments", {"action": asked})
        assert answer["isError"] is True
        # By value, because the agent wrote it and is the one who has to write
        # the next call: told only what this tool does, it cannot see which
        # of the things it sent was the thing complained about.
        assert asked in answer["text"]
        # Nothing answered and nothing done. A refusal that still carried the
        # list would read as an action that half-succeeded.
        assert answer["structured"] is None


def test_the_environments_tool_says_when_the_lab_was_never_asked(mcp: Calling):
    """Absent is not zero, told at the tool level.

    This session was configured on a cycle whose own ask for the lab's
    declaration list failed, so nothing in this process knows what the lab
    has. The answer is what this machine has built, plus the fact that the
    rest is unknown — never a lab that declared nothing, which is what would
    have an agent tell a researcher no other environment exists.
    """
    answer = mcp.call("manage_environments", {"action": "list"})

    assert answer["isError"] is False
    assert answer["structured"]["declarationsKnown"] is False
    assert [row["name"] for row in answer["structured"]["environments"]] == ["python"]
    assert "could not reach the lab" in answer["text"]


@pytest.fixture
def host_with_no_envs(registry: Registry) -> Iterator[Calling]:
    """An agent whose session holds no environments and whose lab declared
    none either — the only pairing that empties both halves of the answer."""
    registry.configure_session(
        session_id="se_1", task_id="tk_1", workspace="/tmp",
        environments=[],
        declared=[],
    )
    yield from _talking(_agent_reaching(registry))


def test_the_environments_tool_says_so_out_loud_when_there_is_nothing_to_list(
    host_with_no_envs: Calling,
):
    """A session that can reach nothing says so, rather than answering blank.

    An empty answer and an answer that arrived empty read the same to an
    agent — and the one thing a tool must not do is let "nothing here" look
    like "nothing came back". The written branch existed; nothing exercised
    it, and dropping the sentence passed all 278 tests.

    Configured with no environments AND a lab that declared none, because
    that is the only pairing that empties both halves: an unasked lab still
    has its own line to say, and a built environment is still a row.
    """
    listed = host_with_no_envs.call("manage_environments", {"action": "list"})

    assert listed["isError"] is False
    assert listed["structured"] == {"environments": [], "declarationsKnown": True}
    assert listed["text"] == "this Task can reach no environments at all"


class StubDaemon:
    """The daemon, as a tool call reaches it.

    A real one holds the researcher's live session and the lab's token, and
    raises a card in front of a person before it answers. What is stood in
    for here is only the shape of that: what was asked, and what came back —
    a declaration, or the refusal a denial arrives as.
    """

    def __init__(
        self,
        *,
        answer: Any = None,
        answers: dict[str, Any] | None = None,
        refusal: str | None = None,
    ) -> None:
        self.asks: list[tuple[str, dict[str, Any]]] = []
        self.answer = answer
        # Per-method answers, for the two asks whose replies are different
        # shapes — a declaration for `environment.create`, a record of what
        # was added for `environment.add_packages`. `answer` is what a method
        # with no row here gets, so the tests written before there were two
        # read exactly as they did.
        self.answers = answers or {}
        # What this daemon refuses with instead of answering — settable
        # mid-test, because a researcher deciding is the one thing about this
        # that changes between one call and the next.
        self.refusal = refusal

    def __call__(self, method: str, params: dict[str, Any]) -> Any:
        self.asks.append((method, params))
        if self.refusal is not None:
            raise ValueError(self.refusal)
        return self.answers.get(method, self.answer)


@pytest.fixture
def daemon() -> StubDaemon:
    return StubDaemon(
        answer={
            "name": "crispr",
            "language": "python",
            "manager": "uv",
            "packages": ["scanpy"],
            "createdBy": "u_ana",
            "createdTs": 1,
            "lockRevision": 0,
        },
        answers={
            # What the lab answers an add with, through the daemon: the
            # declaration as it now stands, which of the asked-for packages
            # were genuinely new, and whether a build is running because of
            # it.
            "environment.add_packages": {
                "declaration": {
                    "name": "python",
                    "language": "python",
                    "manager": "uv",
                    "packages": ["numpy", "scanpy"],
                    "createdTs": 1,
                    "lockRevision": 1,
                },
                "added": ["scanpy"],
                "building": True,
            },
        },
    )


@pytest.fixture
def host_that_can_ask(registry: Registry, tmp_path, daemon: StubDaemon) -> Iterator[Calling]:
    """An agent on a machine whose daemon is there to be asked — which is
    every machine a session was actually opened on."""
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=python_environment(),
        declared=["python"],
    )
    registry.ask_daemon = daemon
    yield from _talking(_agent_reaching(registry))


def test_creating_an_environment_asks_the_daemon_about_this_sessions_own_id(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """What reaches the daemon, and where each part of it came from.

    The name and the packages are the agent's. The session is NOT: it is the
    one this connection was bound to when the daemon built it, the same
    source `list` answers from. Nothing about a session is an argument here,
    which is what keeps an agent inside the namespaces it was given — one
    that could name a session could raise a card in front of a colleague.
    """
    answer = host_that_can_ask.call(
        "manage_environments",
        {"action": "create", "name": "crispr", "packages": ["scanpy", "anndata"]},
    )

    assert answer["isError"] is False
    assert daemon.asks == [
        (
            "environment.create",
            {
                "session_id": "se_1",
                "name": "crispr",
                "packages": ["scanpy", "anndata"],
                # Sent even though the call named no language, and sent as the
                # word rather than left out: two ends defaulting separately is
                # two places to change the default, and the wire saying what is
                # being created is what lets the daemon refuse a language it
                # does not know rather than infer one it does.
                "language": "python",
            },
        )
    ]


def test_creating_an_r_environment_carries_that_language_to_the_daemon(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """The whole point of the argument: an agent asked for R and R is what the
    lab is asked to declare.

    Before this, `create` could only ever produce a Python environment —
    the daemon's route hard-coded the language and nothing on this wire
    carried one. An agent asked for an R environment got a Python one wearing
    that name, which is worse than a refusal: a refusal is a thing a model can
    act on, and a plausible wrong object is not.
    """
    answer = host_that_can_ask.call(
        "manage_environments",
        {"action": "create", "name": "rstats", "packages": ["ggplot2"], "language": "r"},
    )

    assert answer["isError"] is False
    assert daemon.asks == [
        (
            "environment.create",
            {"session_id": "se_1", "name": "rstats", "packages": ["ggplot2"], "language": "r"},
        )
    ]


def test_creating_an_environment_refuses_a_language_by_value(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """Refused HERE, in code, and before the daemon is asked anything.

    The MCP client does not validate arguments against `inputSchema`, so the
    enum published on this tool is a thing a model reads and not a thing that
    holds — every one of these arrives looking exactly like a valid one. A
    language nothing can build must not reach `ask_daemon`, because what
    happens there is a card in front of a researcher: they would be asked to
    approve creating an environment in a language this lab has no provisioner
    for, and whatever they answered would be the wrong question.

    The refusal carries the offending value for the same reason every other
    reader on this surface does — the agent wrote it and has to write the next
    call.
    """
    for wrong in ("ruby", "Python", 7, "", None):
        answer = host_that_can_ask.call(
            "manage_environments",
            {"action": "create", "name": "x", "packages": [], "language": wrong},
        )
        assert answer["isError"] is True, wrong
        assert repr(wrong) in answer["text"], (wrong, answer["text"])

    # Not one of them reached the daemon, so not one of them raised a card.
    assert daemon.asks == []


def test_the_answer_to_a_create_says_it_is_not_built_on_this_machine_yet(
    host_that_can_ask: Calling,
):
    """The one sentence this answer cannot be without.

    A declaration is the lab's and the gigabytes are each machine's (D2), so
    what a create produces is a name and nothing on this disk. A model told
    "created" runs a cell in it on the next call, is refused by name, and
    reads Lykeion as contradicting itself one call later.
    """
    answer = host_that_can_ask.call(
        "manage_environments", {"action": "create", "name": "crispr", "packages": []}
    )

    assert answer["isError"] is False
    assert "crispr" in answer["text"]
    # Case-folded rather than verbatim: the emphasis this sentence puts on
    # the negation is a choice about how a model reads it, not the fact.
    assert "not built on this machine" in answer["text"].lower()
    # Nothing ran: no cell for the lab to keep, the same as `list`.
    assert answer["cell"] is None


def test_an_environment_holding_only_its_interpreter_is_a_thing_to_ask_for(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """An empty list is an answer; an absent one is not.

    Sending `[]` asks for an environment with only its interpreter, which is
    a real request. Sending nothing says nothing about what the environment
    holds, and inventing `[]` for it would declare an empty environment
    lab-wide because a field was forgotten.
    """
    host_that_can_ask.call(
        "manage_environments", {"action": "create", "name": "crispr", "packages": []}
    )
    assert daemon.asks[0][1]["packages"] == []

    absent = host_that_can_ask.call(
        "manage_environments", {"action": "create", "name": "crispr"}
    )
    assert absent["isError"] is True
    assert "empty list" in absent["text"]
    # Nothing was asked for the one nobody described, so no card was raised.
    assert len(daemon.asks) == 1


def test_a_create_with_no_name_is_refused_by_the_value_it_sent(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """The name is refused HERE, before a card is raised for it.

    Nothing between a model and this handler checks an argument against a
    schema, so `name` arrives as whatever was sent — including not at all.
    Left to the daemon, `None` would cost a whole host-to-daemon round trip
    and come back as the daemon's generic sentence about the shape of an ask,
    which tells the agent nothing about which of the things it sent was
    wrong; refused here it comes back naming the value.
    """
    for sent in ({}, {"name": None}, {"name": ""}, {"name": 7}):
        refused = host_that_can_ask.call(
            "manage_environments", {"action": "create", "packages": ["scanpy"], **sent}
        )
        assert refused["isError"] is True
        assert "needs a name" in refused["text"]
        assert refused["structured"] is None
    # Nothing was asked of anybody, so no card was raised for a name that is
    # not one.
    assert daemon.asks == []


def test_a_created_environment_comes_back_with_the_declaration_the_lab_made(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """The structured half is the lab's own record of what was declared.

    Answered from what the daemon handed back and only when that is an object
    — a shape invented here would be this server describing a record it never
    saw. The refusals answer with no structured half at all, and this is the
    other side of that: a successful create is the one call here that has a
    record to carry.
    """
    answer = host_that_can_ask.call(
        "manage_environments", {"action": "create", "name": "crispr", "packages": ["scanpy"]}
    )

    assert answer["isError"] is False
    assert answer["structured"] == {"environment": daemon.answer}
    # And still no cell: a declaration is not work a kernel did.
    assert answer["cell"] is None


def test_a_daemon_that_answers_with_something_other_than_a_record_leaves_no_shape(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """`isinstance(declared, dict)`, from the other side.

    A daemon that answered with something this end cannot read is not a
    declaration. The agent is still told the environment was created — the
    daemon only answers at all once the lab has made it — but nothing is
    invented to stand where the record would be.
    """
    daemon.answer = "crispr"

    answer = host_that_can_ask.call(
        "manage_environments", {"action": "create", "name": "crispr", "packages": ["scanpy"]}
    )

    assert answer["isError"] is False
    assert answer["structured"] is None
    assert "crispr" in answer["text"]


def test_packages_that_are_not_names_are_refused_rather_than_filtered(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """Refused whole, never trimmed to the entries that are names.

    A filtered list is a declaration nobody wrote — pinned for every machine
    in this lab, differing from what the agent sent, with nothing anywhere
    reporting the difference. And it would be approved on a card naming the
    packages that survived.
    """
    for sent in (["scanpy", 7], "scanpy", ["scanpy", ""]):
        refused = host_that_can_ask.call(
            "manage_environments",
            {"action": "create", "name": "crispr", "packages": sent},
        )
        assert refused["isError"] is True
        assert refused["structured"] is None
    assert daemon.asks == []


def test_a_machine_whose_daemon_cannot_be_asked_says_so_and_mints_nothing(
    mcp: Calling, registry: Registry
):
    """Unset is a real state, not a defensive one.

    Every registry built directly is in it, and so is a process whose daemon
    never wired the second direction. What it must not do is answer with a
    success nothing recorded — an agent told its environment exists when no
    lab ever heard the name.
    """
    refused = mcp.call(
        "manage_environments", {"action": "create", "name": "crispr", "packages": ["scanpy"]}
    )

    assert refused["isError"] is True
    assert "crispr" in refused["text"]
    assert "cannot be asked" in refused["text"]
    assert refused["structured"] is None
    # A refusal mints no kernel, the same as every other refusal here.
    assert registry.list() == []


def test_a_create_the_researcher_refused_comes_back_naming_the_environment(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """A denial reaches the agent as this tool's own refusal, by name.

    The daemon is where the researcher's answer is, so its sentence is the
    one worth passing on — and the agent asked for a name, so the refusal has
    to be about that name whatever the daemon happened to say.
    """
    daemon.refusal = "the researcher said no"

    refused = host_that_can_ask.call(
        "manage_environments",
        {"action": "create", "name": "crispr", "packages": ["scanpy"]},
    )

    assert refused["isError"] is True
    assert "the researcher said no" in refused["text"]
    assert "crispr" in refused["text"]
    assert refused["structured"] is None


@pytest.fixture
def host_with_r_and_python(registry: Registry, tmp_path, daemon: StubDaemon) -> Iterator[Calling]:
    """A session holding an R environment beside its Python one.

    The state every machine with a built R environment is in. It used to be
    the state that made the old R refusal testable; it is now what makes the
    absence of that refusal testable, and the two languages side by side are
    what stop a fix for one from quietly answering for the other.
    """
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=python_environment()
        + [
            {
                "language": "r",
                "name": "r",
                "interpreter": sys.executable,
                "prefix": ["/usr/bin/env"],
            }
        ],
        declared=["python", "r"],
    )
    registry.ask_daemon = daemon
    yield from _talking(_agent_reaching(registry))


def test_adding_packages_with_no_environment_named_lands_in_this_sessions_own(
    host_that_can_ask: Calling, registry: Registry, tmp_path, daemon: StubDaemon
):
    """The default is the SESSION's, read live, and not the connection's own.

    A model that has been running cells in the default all conversation must
    not have to name it to add a package to it — and the answer to "which
    environment is that" has to be the same one a cell naming none already
    gets, or this tool adds packages somewhere other than where the next cell
    runs. `Confinement.default_for` is that one answer.

    Which is why the session is reconfigured here, moving the default off the
    environment this connection's own identity names. The two agree on every
    ordinary session — the daemon builds the identity through `identity_for`
    — so a tool reading the identity instead would be indistinguishable from
    one reading the confinement until the moment a session is re-described,
    which is exactly what happens every time this machine finishes a build.
    """
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=[
            {**entry, "default": False} for entry in python_environment()
        ]
        + [{**built_environment(tmp_path, "crispr"), "default": True}],
        declared=["python", "crispr"],
    )

    answer = host_that_can_ask.call("manage_packages", {"packages": ["scanpy"]})

    assert answer["isError"] is False
    assert daemon.asks == [
        (
            "environment.add_packages",
            {"session_id": "se_1", "name": "crispr", "packages": ["scanpy"]},
        )
    ]


def test_adding_packages_to_a_name_this_session_cannot_reach_asks_nobody(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """Refused by name, before the daemon is asked anything.

    The same reachability `list` already reports and a cell naming an unknown
    environment already earns: a name this session was never shown is not one
    it may change. Left to the lab, this would cost a card in front of a
    researcher asking them to approve installing software into a name their
    lab does not have.
    """
    refused = host_that_can_ask.call(
        "manage_packages", {"packages": ["scanpy"], "environment": "atacseq"}
    )

    assert refused["isError"] is True
    assert "atacseq" in refused["text"]
    assert refused["structured"] is None
    assert daemon.asks == []


def test_adding_packages_to_an_unbuilt_environment_this_lab_declares_is_fine(
    host_with_an_unbuilt_env: Calling, registry: Registry, daemon: StubDaemon
):
    """The declaration is the lab's and the gigabytes are each machine's (D2).

    A colleague's environment that nothing on this machine has built is still
    an environment this session can reach — `list` names it, in exactly those
    words — and adding to its declaration is a change to the lab, not to this
    disk. Refusing it here would make the lab's own declaration editable only
    from whichever laptop happened to build it.
    """
    registry.ask_daemon = daemon

    answer = host_with_an_unbuilt_env.call(
        "manage_packages", {"packages": ["scanpy"], "environment": "atacseq"}
    )

    assert answer["isError"] is False
    assert daemon.asks[0][1]["name"] == "atacseq"


def test_adding_no_packages_at_all_is_refused_by_the_value(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """Where this differs from `create`, deliberately.

    An empty list asks a create for an environment holding only its
    interpreter, which is a real request. It asks this tool for nothing to be
    added to something, which is not a state anybody can mean — and taken
    seriously it would put a card in front of a researcher asking them to
    approve installing no software, with a rebuild behind their answer.
    """
    for sent in ({}, {"packages": []}, {"packages": None}, {"packages": "scanpy"}):
        refused = host_that_can_ask.call("manage_packages", dict(sent))
        assert refused["isError"] is True
        assert refused["structured"] is None
    assert daemon.asks == []


def test_a_package_list_holding_something_that_is_not_a_name_is_refused_whole(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """Refused whole, never trimmed to the entries that are names.

    A filtered list is software nobody asked for, installed on every machine
    in this lab, approved on a card naming only the packages that survived
    the filter.
    """
    for sent in (["scanpy", 7], ["scanpy", ""], [None]):
        refused = host_that_can_ask.call("manage_packages", {"packages": sent})
        assert refused["isError"] is True
        assert refused["structured"] is None
    assert daemon.asks == []


def test_an_environment_argument_that_is_not_a_name_is_refused_by_the_value(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """Refused by value, and NOT quietly treated as "not given".

    Nothing between a model and this handler checks an argument against
    `inputSchema`, so `environment: ["crispr"]` — a model emitting an array
    where a string is expected — arrives looking exactly like a name. Answered
    with the session's default, it would install lab-wide software into an
    environment the agent never named, on a card reading as though it were
    about the default one. The same guard `_optional_text` gives a cell,
    refusing in this tool's own words rather than a cell's: `manage_packages`
    starts no cell, and a refusal talking about one sends the agent looking
    for a mistake it did not make.
    """
    for sent in (["crispr"], 3, "", {"name": "crispr"}, True):
        refused = host_that_can_ask.call(
            "manage_packages", {"packages": ["scanpy"], "environment": sent}
        )
        assert refused["isError"] is True
        assert "package change" in refused["text"]
        assert refused["structured"] is None
    # Nothing was asked of anybody, so no card was raised for a value that is
    # not a name.
    assert daemon.asks == []


@pytest.fixture
def host_with_no_python_default(
    registry: Registry, tmp_path, daemon: StubDaemon
) -> Iterator[Calling]:
    """A session whose confinement names a Python environment and defaults to
    none — what a machine that could render no Python boundary leaves
    behind."""
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=[{**entry, "default": False} for entry in python_environment()],
        declared=["python"],
    )
    registry.ask_daemon = daemon
    yield from _talking(_agent_reaching(registry))


def test_a_session_with_no_python_environment_is_told_that_rather_than_a_guess(
    host_with_no_python_default: Calling, daemon: StubDaemon
):
    """A confinement with no Python default at all.

    `Confinement.default_for` answers `None` there, and this tool has nothing
    to fall back on — inventing `"python"` would refuse by a name the caller
    never sent, sending the agent to look for an environment it did not ask
    about.
    """
    refused = host_with_no_python_default.call("manage_packages", {"packages": ["scanpy"]})

    assert refused["isError"] is True
    assert "no Python environment" in refused["text"]
    assert refused["structured"] is None
    assert daemon.asks == []


def test_adding_packages_to_a_built_r_environment_reaches_the_lab(
    host_with_r_and_python: Calling, daemon: StubDaemon
):
    """The inverse of what this asserted, and the inversion is the point.

    While the provisioner built Python environments alone, naming the R floor
    here would have added PyPI packages to it, so it was refused by name.
    Both halves of that reasoning are gone: R environments are declared and
    built, and what rebuilds one is decided by the lab from the declaration's
    own `manager`, not here.

    Refusing was also the wrong way round in practice. A row for an
    environment this machine has BUILT carries `language`, so the old guard
    refused exactly the environments an R cell can run in — while a declared
    but unbuilt row carries no `language` at all and sailed through. And
    `execute_r_cell`'s own published description tells a model to use this
    tool for a permanent R package, which made the refusal a promise the same
    process broke.
    """
    answer = host_with_r_and_python.call(
        "manage_packages", {"packages": ["ggplot2"], "environment": "r"}
    )

    assert answer["isError"] is False, answer["text"]
    # It reached the daemon, which is what "the lab was asked" means here —
    # a refusal that answered nicely would still leave nothing declared.
    assert [method for method, _ in daemon.asks] == ["environment.add_packages"]
    assert daemon.asks[0][1]["name"] == "r"
    assert daemon.asks[0][1]["packages"] == ["ggplot2"]


def test_an_add_naming_no_environment_uses_this_connections_own_language(
    registry: Registry, tmp_path, daemon: StubDaemon
):
    """Whose default, when the call names none.

    `manage_packages` has no language argument — the environment is the whole
    of what it addresses — so the default has to come from somewhere, and the
    somewhere is this connection's own kernel. An agent working in R that
    names nothing means its R environment; answering with Python's would add
    R packages to a Python environment, and refusing with "this Task has no
    Python environment" would be true and useless.

    Both languages are declared here so a hard-coded "python" cannot pass by
    happening to be the only thing present.
    """
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=python_environment()
        + [
            {"language": "r", "name": "rstats", "interpreter": sys.executable,
             "prefix": ["/usr/bin/env"], "default": True},
        ],
        declared=["python", "rstats"],
    )
    registry.ask_daemon = daemon
    reaching = Reach(
        registry=registry,
        identity=KernelIdentity(
            session_id="se_1", task_id="tk_1", name="main",
            language="r", environment="rstats",
        ),
        agent="claude",
    )
    # `_talking` is a generator other fixtures delegate to, so it is driven
    # here the way a fixture drives it rather than as a context manager.
    talking = _talking(reaching)
    calling = next(talking)
    try:
        answer = calling.call("manage_packages", {"packages": ["ggplot2"]})
    finally:
        next(talking, None)

    assert answer["isError"] is False, answer["text"]
    assert daemon.asks[0][1]["name"] == "rstats"


def test_the_answer_to_an_add_says_the_build_has_not_finished_and_where_to_look(
    host_that_can_ask: Calling,
):
    """The one sentence this answer cannot be without, and no more than is known.

    Nothing here waits for the rebuild — the lab's own route does not either
    — so a model told "scanpy was added" writes `import scanpy` in its very
    next cell, into a kernel whose environment has not been rebuilt yet, and
    reads the ImportError as its own mistake.

    What this end actually knows is that the lab ASKED a machine to rebuild.
    It cannot see whether that build has started, and for an add that joined a
    build already in flight it demonstrably has not — so "rebuilding NOW"
    would be a sentence stronger than the fact.

    And a model told to wait has to be given something to wait FOR:
    `manage_environments` with `action: "list"` is where the rebuild becomes
    observable, and the answer names it.
    """
    answer = host_that_can_ask.call("manage_packages", {"packages": ["scanpy"]})

    assert answer["isError"] is False
    assert "scanpy" in answer["text"]
    assert "python" in answer["text"]
    assert "NOT finished" in answer["text"]
    assert "will still fail" in answer["text"]
    # Told where to look, by the name of the tool that answers it.
    assert "manage_environments" in answer["text"]
    # And nothing claiming a build is under way on this disk right now.
    assert "NOW" not in answer["text"]
    # And no cell: adding packages is not work a kernel did.
    assert answer["cell"] is None


def test_an_add_the_lab_started_no_build_for_does_not_tell_the_model_to_wait(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """`building`, read rather than merely carried through.

    Only the lab knows whether it managed to ask a machine for a build. A
    model told "wait for the rebuild" when none was asked for waits forever;
    one told the packages are ready when nothing holds them imports something
    that is not there. Three states, three sentences, and this is the one that
    would be invented if `building` were ignored.
    """
    daemon.answers["environment.add_packages"] = {
        "declaration": {
            "name": "python", "language": "python", "manager": "uv",
            "packages": ["numpy", "scanpy"], "createdTs": 1, "lockRevision": 1,
        },
        "added": ["scanpy"],
        "building": False,
    }

    answer = host_that_can_ask.call("manage_packages", {"packages": ["scanpy"]})

    assert answer["isError"] is False
    assert "No rebuild was started" in answer["text"]
    # Not told to go looking for a build that nobody asked for.
    assert "manage_environments" not in answer["text"]
    assert "NOT finished" not in answer["text"]


def test_adding_only_what_is_already_declared_says_nothing_is_being_rebuilt(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """Not an error — it is the state the caller asked for, already reached.

    But it must not read as a change either: nothing was written and nothing
    is being rebuilt, so a model told to wait for a build would wait forever,
    and one told the package is on its way would go on believing it is coming.
    """
    daemon.answers["environment.add_packages"] = {
        "declaration": {
            "name": "python",
            "language": "python",
            "manager": "uv",
            "packages": ["numpy"],
            "createdTs": 1,
            "lockRevision": 1,
        },
        "added": [],
        "building": False,
    }

    answer = host_that_can_ask.call("manage_packages", {"packages": ["numpy"]})

    assert answer["isError"] is False
    assert "already holds" in answer["text"]
    assert "still running" not in answer["text"]
    assert "Nothing was added" in answer["text"]


def test_adding_only_what_is_already_declared_still_says_so_when_a_build_IS_running(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """`added: []` and `building: true` is the retry, and it has its own answer.

    The lab dispatches a build on an empty `added` when its pin no longer
    answers the declaration — the state a FAILED build leaves, where the
    package is declared and no machine holds it. That is the only recovery an
    agent has: nothing renders "declared past its pin", and no other call
    starts a build for a package already declared. Reading `building` off the
    answer rather than off `added` is what keeps this branch from telling the
    agent nothing is coming and sending it away from the call that fixes it.
    """
    daemon.answers["environment.add_packages"] = {
        "declaration": {
            "name": "python",
            "language": "python",
            "manager": "uv",
            "packages": ["numpy"],
            "createdTs": 1,
            "lockRevision": 1,
        },
        "added": [],
        "building": True,
    }

    answer = host_that_can_ask.call("manage_packages", {"packages": ["numpy"]})

    assert answer["isError"] is False
    # Honest about the declaration: nothing was added to it.
    assert "nothing was added to this lab\'s list" in answer["text"]
    # And honest about the build, which is the half this branch used to deny.
    assert "HAS asked this machine to rebuild python" in answer["text"]
    assert "nothing is being rebuilt" not in answer["text"]
    # And it says where the landing becomes observable, as the ordinary
    # rebuilding answer does — a model told to wait needs something to wait for.
    assert "manage_environments" in answer["text"]


def test_an_add_the_researcher_refused_comes_back_naming_the_environment(
    host_that_can_ask: Calling, daemon: StubDaemon
):
    """A denial reaches the agent as this tool's own refusal, by name — the
    same reasoning `_created`'s does. The agent asked about an environment and
    is the one who has to write the next call."""
    daemon.refusal = "the researcher said no"

    refused = host_that_can_ask.call("manage_packages", {"packages": ["scanpy"]})

    assert refused["isError"] is True
    assert "the researcher said no" in refused["text"]
    assert "python" in refused["text"]
    assert refused["structured"] is None


def test_a_machine_whose_daemon_cannot_be_asked_adds_nothing_and_says_so(
    mcp: Calling, registry: Registry
):
    """Unset is a real state, not a defensive one. What it must not do is
    answer with a success nothing recorded — an agent told its packages are
    installing when no lab ever heard of them."""
    refused = mcp.call("manage_packages", {"packages": ["scanpy"]})

    assert refused["isError"] is True
    assert "python" in refused["text"]
    assert "cannot be asked" in refused["text"]
    assert refused["structured"] is None
    assert registry.list() == []


def test_every_tool_that_reaches_an_interpreter_says_uv_pip_will_not_work(
    mcp: Calling,
):
    """The one thing an agent cannot find out from the outside.

    `uv pip install` aims at the environment, which the boundary refuses — so
    what comes back is uv complaining about a directory the agent never named,
    which reads as a broken machine rather than as a rule. The note on a cell's
    answer cannot help: it only fires on an install that WORKED. Said on the
    tools instead, where a model reads it before it tries.
    """
    published = {tool.name: tool.description or "" for tool in mcp.tools().tools}
    for name in ("execute_python_cell", "execute_shell_cell"):
        assert "uv pip install" in published[name], name
        assert "does NOT work here" in published[name], name
        # And where to go instead — both the thing that works now and the
        # thing that lasts.
        assert "pip" in published[name] and "manage_packages" in published[name], name
    # Not on the tools that reach no interpreter: R has no pip, and the two
    # environment tools install nothing themselves.
    assert "uv pip install" not in published["manage_environments"]
    assert "uv pip install" not in published["manage_packages"]


def test_a_shell_cell_that_installed_something_is_noticed_like_any_other(mcp: Calling):
    """A shell cell is the spelling source scanning misses hardest.

    Nothing here mentions pip. The command makes two directories of the shape
    an install leaves, which is the whole of what any of `!pip install`,
    `%pip`, `python -m pip`, `uv pip` or a Makefile amounts to on this disk —
    and the mechanism notices it, because it looks at the disk.
    """
    made = mcp.call(
        "execute_shell_cell",
        {"command": 'mkdir -p "$PIP_TARGET/scanpy" "$PIP_TARGET/scanpy-1.10.dist-info"'},
    )
    assert made["cell"]["ok"] is True
    assert made["cell"]["installed"] == ["scanpy"]


def test_the_agent_is_told_an_install_will_not_last_and_what_makes_it_last(
    mcp: Calling,
):
    """Said in the answer the model reads, not only in the record the lab keeps.

    A model that ran an install and read a successful cell has every reason to
    believe the package is there for good. It is not, and the sentence that
    says so has to reach the thing that would otherwise write a notebook
    nobody else in the lab can run.
    """
    answer = mcp.call(
        "execute_python_cell",
        {
            "code": (
                "import os, pathlib\n"
                "target = pathlib.Path(os.environ['PIP_TARGET'])\n"
                "(target / 'scanpy').mkdir(parents=True)\n"
                "print('the cell said this')\n"
            )
        },
    )
    # The cell's own output first, and the note after it rather than instead.
    assert answer["text"].startswith("the cell said this")
    assert "scanpy was installed into this kernel only" in answer["text"]
    assert "gone when it restarts" in answer["text"]
    # Named, so the model has somewhere to go: the tool, and the environment
    # the cell actually ran in.
    assert "manage_packages" in answer["text"]
    assert "python environment" in answer["text"]


def test_a_cell_that_installed_nothing_is_told_nothing_about_installing(mcp: Calling):
    """Absent is not zero, on the surface a model reads.

    A note on every cell is a note the model learns to skip, and the one cell
    it matters on is then the one it skips too.
    """
    answer = mcp.call("execute_python_cell", {"code": "print('just a cell')"})
    assert answer["text"] == "just a cell\n"
    assert "installed" not in answer["cell"]


def test_execute_shell_cell_brings_its_output_back_as_the_cell_it_ran(mcp: Calling):
    answer = mcp.call("execute_shell_cell", {"command": "echo eleven rows"})
    assert "eleven rows" in stdout_of(answer)
    assert answer["cell"]["ok"] is True


def test_a_shell_command_leaves_the_researchers_own_names_alone(mcp: Calling):
    mcp.call("execute_python_cell", {"code": "subprocess = 'mine'"})
    mcp.call("execute_shell_cell", {"command": "echo hello"})
    assert "mine" in stdout_of(mcp.call("execute_python_cell", {"code": "print(subprocess)"}))


def test_a_quote_in_a_command_is_part_of_it_and_not_the_end_of_it(mcp: Calling):
    # The command travels as one string inside an argument list, so nothing in
    # it can close the list and become code of its own.
    answer = mcp.call("execute_shell_cell", {"command": "printf '%s' \"it's one argument\""})
    assert stdout_of(answer) == "it's one argument"


def test_a_shell_command_that_failed_says_so_without_ending_the_cell(mcp: Calling):
    answer = mcp.call("execute_shell_cell", {"command": "exit 3"})
    # The command failed and the cell ran, which are two different facts, and
    # the agent is told both rather than left to read one as the other.
    assert answer["cell"]["ok"] is True
    assert "ended with status 3" in answer["text"]


def test_a_cell_that_raised_comes_back_as_a_failed_call_carrying_the_traceback(mcp: Calling):
    answer = mcp.call("execute_python_cell", {"code": "raise ValueError('no such column')"})
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
        environments=python_environment(),
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
        environments=python_environment(),
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
    declared = {"mcp", "psutil"}
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
        environments=python_environment(),
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


# ---------------------------------------------------------------------------
# What a tool does with an argument of a shape it never published.
#
# Nothing between a model and `on_call_tool` checks an argument against a
# schema — not the SDK, which validates only that `tools/call` carried a name
# and a dict, and not this host until one of the handwritten guards in
# `mcp/server.py` reads it. Six of those guards were written separately, with
# no shared primitive between them, and a review found five refusals that
# could be deleted with the whole suite still green.
#
# The tests below are written against the SCHEMAS rather than against the
# guards, which is the difference that matters: a walk over what was actually
# published cannot go stale when a property is added, and it fails loudly for
# a new one nobody wrote a wrong value for (see `_ARGUMENTS`). Reaching every
# guard by hand would have covered the five that existed on the day and
# nothing after them, which is how the five got here.
# ---------------------------------------------------------------------------


def _wrong_values(spec: dict[str, Any]) -> list[Any]:
    """Values a property's OWN published type says are not values of it.

    Derived from the schema, so a property whose type changes gets the wrong
    values for its new type without anyone editing this. `[]` is deliberately
    not among them: an empty list means different things to different tools
    here — an environment holding only its interpreter on a create, and a
    request nobody can mean on an add — so it is a case for a named test and
    not for a generic walk.
    """
    declared = spec.get("type")
    if declared == "string":
        wrong: list[Any] = [7, True, ["a name"], {"a": "name"}]
        # A published enum is part of the type. A string is the right shape
        # and still not one of the things the tool said it does, and an
        # unpublished action falling through to a published one would be a
        # capability nobody offered.
        if spec.get("enum"):
            wrong.append("not-an-action-this-tool-published")
        return wrong
    if declared == "array":
        return ["scanpy", 7, {"0": "scanpy"}, [7], [""], [None]]
    raise AssertionError(
        f"a {declared!r} property is published and this walk has no wrong values for it"
    )


# One VALID call per published tool, which every case below starts from and
# spoils exactly one argument of. Complete rather than minimal — every
# property a tool publishes has to appear, including the optional ones, or an
# optional argument's guard would never be reached. `_ARGUMENTS` is checked
# against the schemas themselves in the first test, so a property added to a
# tool without a value here fails rather than being silently skipped.
_ARGUMENTS: dict[str, dict[str, Any]] = {
    "execute_python_cell": {"code": "1", "environment": "python"},
    # A REACHABLE R environment, not a plausible-looking name: every case
    # below spoils one argument and expects the refusal to be about THAT
    # argument, so the others have to be values this session can actually
    # resolve. `host_reading_shapes` declares this one for exactly that.
    "execute_r_cell": {"code": "1", "environment": "r"},
    "execute_shell_cell": {"command": "true", "environment": "python"},
    "manage_environments": {
        "action": "create", "name": "crispr", "packages": ["scanpy"], "language": "python",
    },
    "manage_packages": {"packages": ["scanpy"], "environment": "python"},
}

# Exactly what `server_for` publishes, on this machine and every other one —
# `tools_for` over `LAUNCHERS`, the same capability-in-principle set
# `Registry.capable_languages` reads, since publication no longer depends on
# what a machine happens to have discovered (Task 6's follow-up). Walked at
# import so each case is its own test with its own name.
_PUBLISHED = tools_for(tuple(LAUNCHERS))
_SHAPES = [
    (tool.name, key, wrong)
    for tool in _PUBLISHED
    for key, spec in tool.input_schema["properties"].items()
    for wrong in _wrong_values(spec)
]


@pytest.fixture
def host_reading_shapes(registry: Registry, tmp_path, daemon: StubDaemon) -> Iterator[Calling]:
    """`host_that_can_ask`, with the server answering its own exceptions.

    Two of the guards under test raise out of `on_call_tool` rather than
    answering `_refused` — `_text`'s, and the unpublished-tool-name one — and
    the SDK turns a raised handler exception into a JSON-RPC error for the
    client. That is what an agent actually sees, because `endpoint.py` runs
    the server with no `raise_exceptions` flag at all; the suite's usual
    `True` additionally re-raises it out of `server.run`, which would end the
    connection mid-test. So these tests run the server the way production
    runs it.
    """
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        # An R environment as well, because `execute_r_cell` publishes an
        # `environment` now and the walk needs a valid value for it. The
        # interpreter is a path that does not exist, which costs nothing:
        # every case in this walk is a refusal, so no kernel of either
        # language is ever launched from this fixture.
        environments=python_environment()
        + [
            {"language": "r", "name": "r", "interpreter": "/nonexistent/bin/Rscript",
             "prefix": ["/usr/bin/env"], "default": True},
        ],
        declared=["python", "r"],
    )
    registry.ask_daemon = daemon
    yield from _talking(_agent_reaching(registry), raise_exceptions=False)


def test_every_published_argument_has_a_valid_value_written_for_this_walk():
    """The walk covers the schemas as they are, not as they were.

    `_ARGUMENTS` is what every case below spoils one argument of, so a
    property published without a value here would be a property the walk
    silently skipped — which is exactly how a guard ships untested. Asserted
    as a set equality in both directions: a stale entry for a property that
    was removed is as much a lie about coverage as a missing one.
    """
    for tool in _PUBLISHED:
        assert tool.name in _ARGUMENTS, f"{tool.name} is published and this walk skips it"
        assert set(_ARGUMENTS[tool.name]) == set(tool.input_schema["properties"]), (
            f"{tool.name}'s published properties and the values this walk sends have drifted"
        )


@pytest.mark.parametrize(("tool", "key", "wrong"), _SHAPES, ids=lambda part: repr(part))
def test_an_argument_of_a_shape_a_tool_never_published_is_refused_and_nothing_runs(
    host_reading_shapes: Calling,
    registry: Registry,
    daemon: StubDaemon,
    tool: str,
    key: str,
    wrong: Any,
):
    """Every published argument, given a value its own schema excludes.

    Refused is the claim, and "nothing happened" is the half that makes it
    worth asserting. A guard deleted does not usually produce an error — it
    produces a cell built out of a Python repr in the researcher's own
    namespace (`code: 42` becomes the source `42`), a `/bin/sh -c` on the same
    (`command`), a card raised in front of a researcher for a package list
    nobody could read, or a tool quietly answering the action it publishes for
    one it does not. So each case asserts that the call was refused AND that
    no cell exists, no kernel was minted, and the daemon was never asked.
    """
    before = len(registry.list())
    asked = len(daemon.asks)

    answer = host_reading_shapes.call(tool, {**_ARGUMENTS[tool], key: wrong})

    assert answer["isError"] is True, f"{tool} accepted {key}={wrong!r}"
    # A refusal mints nothing: no cell for the lab to keep, and no entry on a
    # researcher's machine for a kernel that was never going to start.
    assert answer["cell"] is None, f"{tool} ran a cell for {key}={wrong!r}"
    assert len(registry.list()) == before, f"{tool} minted a kernel for {key}={wrong!r}"
    # And no card. A malformed argument must not reach a researcher as a
    # question about software they cannot read.
    assert len(daemon.asks) == asked, f"{tool} asked the daemon about {key}={wrong!r}"


def test_a_tool_name_this_machine_never_published_is_refused_before_anything_is_resolved(
    registry: Registry, tmp_path, daemon: StubDaemon, monkeypatch
):
    """`runners` is not filtered by what was published, so this is the gate.

    `_BY_LANGUAGE` (in `server.py`) holds a runner per language this host
    KNOWS ABOUT, and `server_for` builds `runners` from it unconditionally —
    while `published` is built from `capable_languages`, i.e. `LAUNCHERS` (in
    `registry.py`). The two independently-hardcoded dicts name the same two
    languages today, so proving the gate still does something requires a
    genuine mismatch between them — manufactured here by deleting R from
    `LAUNCHERS` itself, since publication no longer moves with what a machine
    happens to have discovered (Task 6's follow-up made trimming
    `registry._runnables`, the old way to fake this, do nothing at all).
    `params.name not in named` is the only thing between a call naming the
    removed language and `identity_for(..., "r", None)`. A working
    capability behind an unpublished surface is this machine's reachability
    rule in reverse.

    The session is given an R environment anyway, for the same reason as
    before: without one the call would be refused by `identity_for` even
    with the gate gone, and the test would pass for a reason that is not the
    gate.
    """
    monkeypatch.delitem(LAUNCHERS, "r")
    registry.configure_session(
        session_id="se_1",
        task_id="tk_1",
        workspace=str(tmp_path),
        environments=python_environment()
        + [
            {
                "language": "r", "name": "r",
                "interpreter": sys.executable, "prefix": ["/usr/bin/env"], "default": True,
            }
        ],
        declared=["python"],
    )
    registry.ask_daemon = daemon
    with _conversation(_agent_reaching(registry), raise_exceptions=False) as calling:
        published = {tool.name for tool in calling.tools().tools}
        assert "execute_r_cell" not in published

        for unpublished in ("execute_r_cell", "execute_ruby_cell"):
            refused = calling.call(unpublished, {"code": "1"})
            assert refused["isError"] is True
            # By the tool's NAME, and that is the assertion that pins the
            # gate: without it `execute_r_cell` reaches `identity_for` and is
            # refused — or not — for something else entirely.
            assert f"publishes no tool named {unpublished}" in refused["text"]
            assert refused["cell"] is None
            assert registry.list() == []


def test_manage_packages_says_MACHINE_when_it_could_not_learn_what_the_lab_declares(
    registry: Registry, tmp_path, daemon: StubDaemon
):
    """Three absences, three sentences — and this one is about which.

    A session configured with no `declared` list is one whose daemon could not
    read what this lab declares. Told "this LAB has no environment named X"
    there, an agent is handed a claim about the lab by a machine that could
    not reach it — and a researcher is sent looking for a colleague's
    environment that may well exist. The machine-scoped sentence is the only
    one true under both absences, which is the same reading `identity_for`
    applies to the same state; `manage_packages` has its own copy of the rule
    and it is the copy nothing was pinning.

    Both directions in one test, because a single sentence asserted alone
    passes just as well against a handler that has only ever heard of it.
    """
    registry.ask_daemon = daemon

    def refusal(declared: list[str] | None) -> str:
        registry.configure_session(
            session_id="se_1", task_id="tk_1", workspace=str(tmp_path),
            environments=python_environment(),
            **({} if declared is None else {"declared": declared}),
        )
        with _conversation(_agent_reaching(registry)) as calling:
            answer = calling.call(
                "manage_packages", {"packages": ["scanpy"], "environment": "nonesuch"}
            )
            assert answer["isError"] is True
            return answer["text"]

    unknown = refusal(None)
    assert "this machine has no environment named nonesuch" in unknown
    assert "lab" not in unknown

    known = refusal(["python"])
    assert "this lab has no environment named nonesuch" in known
    # Nothing was asked of anybody either way: a name this session cannot
    # reach is refused before a card is raised for it.
    assert daemon.asks == []


def test_a_malformed_tool_use_id_leaves_the_cell_without_one(mcp: Calling):
    """Absent, non-string and empty are one answer: no id at all.

    `kernels.ts` forwards this with `??`, so an empty string survives to the
    lab's wire as `toolUseId: ""` — a cell claiming to name a record in the
    agent's transcript, pointing at nothing. The daemon may still join the
    cell to its step by observation, and it cannot do that for a cell that
    already carries an id it will never match.
    """
    for malformed in ({"claudecode/toolUseId": ""}, {"toolUseId": 7}, {"toolCallId": None}):
        cell = mcp.call("execute_python_cell", {"code": "1"}, meta=malformed)["cell"]
        assert "toolUseId" not in cell, f"{malformed!r} became an id"
