"""The tools this machine publishes, and the kernels they run in.

One runner per language this machine can start a kernel in, and the shell — so
a machine with R publishes three and a machine without it two.

Every one of them is bound to one `Reach` when the server is built — the
context, the Task, and who is running the cell — so no tool takes a session, a
Task, or a kernel's own name as an argument. That is what keeps an agent inside
the namespaces it was given. The one thing a call may say about where it lands
is which of its own session's environments to run in, and that name is resolved
against that session's confinement like every other: a name the session does
not hold reaches a refusal rather than another session's work.

A tool answers with the cell, twice over. The structured half is the record
the lab keeps; the text half is what the agent reads, which is the cell's own
output and nothing about how it was run. When a call's `_meta` carries the
caller's own id for it, the cell keeps that id too, so the record the lab
keeps and the record the agent's transcript keeps name the same event.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
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
    """One context's kernels, and who is reaching them.

    Everything a tool needs beyond the code itself, decided by the daemon and
    fixed before the agent's first message is read. The identity's language is
    the one an unaddressed call would run in; each tool names its own, because
    a context owns one kernel per language it writes. Its environment is what
    a call that names none runs in, which is this session's own default —
    resolved through `identity_for` the same way a named one is.
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


# How many of a cell's installed packages are named before the rest are
# counted. One `pip install scanpy` brings sixty distributions with it, and
# sixty names ahead of the cell's own output is the output buried under a
# footnote. Enough to recognise what happened, and a count for the rest.
NAMED_AT_MOST = 8


def _installed_note(cell: dict[str, Any]) -> str | None:
    """What the agent is told about an install that happened inside its cell.

    Said out loud, and said HERE rather than left to the structured half,
    because a model that ran `!pip install scanpy` and read a successful cell
    has every reason to believe scanpy is now installed. It is — for this
    process, until it restarts, and for nobody else in the lab. Left unsaid,
    the model writes a notebook that works this afternoon and fails for the
    colleague who opens it, and neither of them has anything to read that
    explains why.

    So the sentence carries three facts and no more: what arrived, that it is
    this kernel only and goes when the kernel does, and which tool makes it
    permanent. The environment is named from the cell rather than from the
    session's default — a kernel's identity already carries the environment
    it ran in, so a cell that named one is told about the one it actually
    used.

    `None` where nothing was installed, which is the ordinary case and must
    add nothing at all to what the agent reads.
    """
    installed = cell.get("installed")
    if not installed:
        return None
    named = ", ".join(installed[:NAMED_AT_MOST])
    rest = len(installed) - NAMED_AT_MOST
    if rest > 0:
        named += f" and {rest} more"
    was = "was" if len(installed) == 1 else "were"
    environment = cell.get("environment")
    return (
        f"{named} {was} installed into this kernel only, and will be gone when it"
        f" restarts — nothing on this machine outside this kernel can import"
        f" {'it' if len(installed) == 1 else 'them'}, and no colleague's machine has"
        f" {'it' if len(installed) == 1 else 'them'} at all. Call manage_packages to add"
        f" packages to the {environment} environment permanently, pinned for every"
        " machine in this lab."
    )


def _answer(cell: dict[str, Any]) -> types.CallToolResult:
    # After the cell's own output, never in place of it: what the agent asked
    # for is the result of its code, and a note about the machine that ran it
    # is a second thing said afterwards.
    read = _read(cell)
    note = _installed_note(cell)
    return types.CallToolResult(
        content=[
            types.TextContent(
                type="text",
                text=read if note is None else f"{read.rstrip()}\n\n{note}".lstrip(),
            )
        ],
        structuredContent={"cell": cell},
        # A cell that raised is a failed tool call. The output still travels:
        # a traceback is what the agent needs in order to write the next cell.
        isError=not cell.get("ok", False),
    )


# Which environment a cell runs in, offered to the caller — the one thing on
# any of these tools that says anything about where a cell lands.
#
# Safe as an argument where phase 1's rejected language enum was not, and for
# a reason that is about what a wrong value does rather than about how likely
# one is. A wrong language would mint a real cell in the wrong namespace and
# report a syntax error, which reads as the researcher's own code being
# wrong. A wrong environment cannot be started at all: `identity_for` resolves
# it against this session's own confinement before a place is taken, and a
# name that is not in it is refused by name — so the failure is loud, says
# which name, and leaves no kernel behind.
#
# Never in `required`. A cell that names no environment behaves exactly as
# every cell did before this argument existed: it runs in this session's
# default for its language.
#
# One object, shared by every tool that publishes it, so two tools cannot come
# to say different things about the same argument. Nothing mutates a published
# schema; they are built once, here, and handed out as they are.
_ENVIRONMENT = {
    "type": "string",
    "description": (
        "Which named environment to run in. Omit for this Task's "
        "default. An environment that does not exist is refused by "
        "name rather than run somewhere else."
    ),
}

# What an agent is told about installing things before it tries, rather than
# after it has read a permission error it cannot account for.
#
# It is one sentence because it has to survive being skimmed, and it says the
# two things a model cannot find out from the outside. First: `pip install`
# works and does not last — the packages land in this kernel's own overlay and
# go when it restarts, which the answer to such a cell also says, but only
# once it has already happened. Second, and this is the part nothing else
# anywhere would tell it: `uv pip install` CANNOT work here. uv reads `UV_*`
# and has never heard of `PIP_TARGET`, so it aims at the environment itself
# and the boundary refuses the write — and what comes back is uv complaining
# about a directory the agent never named, which reads exactly like a broken
# machine. An agent that then retries it, or reports the researcher's install
# as broken, is the failure this sentence exists to prevent.
#
# One constant, shared by both tools that can reach an interpreter, so the
# runner and the shell cannot come to say different things about the same
# machine.
_INSTALLING = (
    " Installing: `pip install` works and lasts only until this kernel "
    "restarts — it goes into this kernel alone and no colleague's machine "
    "has it. `uv pip install` does NOT work here and is refused by the "
    "boundary; use `pip` for a quick trial, and manage_packages to add a "
    "package to the environment for good, pinned for every machine in this lab."
)

EXECUTE_PYTHON_CELL = types.Tool(
    name="execute_python_cell",
    title="Execute Python cell",
    description=(
        "Run Python in this Task's kernel. The namespace is held open between "
        "calls, so a name bound by one call is still bound in the next." + _INSTALLING
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "The Python to run."},
            "environment": _ENVIRONMENT,
        },
        "required": ["code"],
    },
)

# No `environment` here, deliberately. This phase builds Python environments
# only — the provisioner's sources are `uv` and PyPI, and the daemon calls a
# build ready by probing its `bin/python3` — so there is no R environment for
# any value of one to name. Published, it would be an argument every value of
# which can only ever be refused, which is worse than an absent one: it tells
# an agent that naming an R environment is a thing this machine does. R
# environments are a scheduled follow-on, and this is where to add it.
#
# The omission is load-bearing rather than documentary: `on_call_tool` reads
# `environment` only off the tools whose schema carries it, so adding it here
# is what would make it work, and sending one to this tool today does nothing.
EXECUTE_R_CELL = types.Tool(
    name="execute_r_cell",
    title="Execute R cell",
    description=(
        "Run R in this Task's R kernel. The namespace is held open between "
        "calls, so a name bound by one call is still bound in the next."
    ),
    inputSchema={
        "type": "object",
        "properties": {"code": {"type": "string", "description": "The R to run."}},
        "required": ["code"],
    },
)

EXECUTE_SHELL_CELL = types.Tool(
    name="execute_shell_cell",
    title="Execute shell cell",
    description=(
        "Run one shell command inside the same boundary as this Task's kernel, "
        "in the Task's own directory. Its output comes back as the cell's output."
        + _INSTALLING
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The command to run."},
            # A shell command runs inside a Python kernel, so the environment
            # it names is that kernel's — `pip list` in `crispr` is a question
            # about `crispr` and is answered by the interpreter it names.
            "environment": _ENVIRONMENT,
        },
        "required": ["command"],
    },
)

# `create` and `list`, and the schema says so rather than leaving the argument
# free-form: what a tool can do is a thing an agent reads before it calls, not
# a thing it discovers from a refusal.
#
# **No `delete`, ever.** D7 of the spec: an environment is lab-wide and is
# gigabytes on somebody else's laptop, and removing one is not a thing to do by
# conversational inference. A researcher deletes one on Machines, where they
# can see whose machine it is on and what goes with it. This is a decision, not
# an omission — do not add it back here as an oversight.
#
# **`create` declares; it does not build.** D2: the declaration is the lab's
# and the gigabytes are each machine's. What this action produces is a name
# this lab now holds, attributed to the researcher whose session asked for it
# and approved by them on a permission card first — nothing installs, and no
# cell can run in it until somebody builds it on this machine. The answer says
# exactly that, because a model told "created" and refused one call later
# reads Lykeion as contradicting itself.
MANAGE_ENVIRONMENTS = types.Tool(
    name="manage_environments",
    title="Manage environments",
    description=(
        "List the named environments this Task can run a cell in, and which of "
        "them this machine has already built, or ask this lab to declare a new "
        "one. An environment this lab declared and this machine has not built "
        "is named too, so it can be offered rather than guessed at. Creating "
        "one asks the researcher first, and declares it rather than building "
        "it: no package is installed by this call."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["create", "list"],
                "description": (
                    "`list` names every environment this Task can reach and "
                    "which of them are built on this machine. `create` asks "
                    "this lab to declare a new one, which the researcher has "
                    "to allow before anything is recorded."
                ),
            },
            "name": {
                "type": "string",
                "description": (
                    "What the environment being created is to be called. "
                    "Letters, numbers, dashes and underscores, since every "
                    "machine builds it into a folder of that name."
                ),
            },
            "packages": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "The packages the new environment is to hold, by name. "
                    "Send an empty list for an environment holding only its "
                    "interpreter — never a list containing an empty string, "
                    "which asks for a package with no name."
                ),
            },
        },
        "required": ["action"],
    },
)

# The other verb on an environment: adding to one that already exists.
#
# Separate from `manage_environments` rather than a third action on it,
# because the two are different consequences and a researcher answers for them
# on differently-worded cards. Creating declares a name and installs nothing;
# this one changes what is already running, on every machine in this lab, and
# ends the kernels that were running in it.
#
# **The environment is optional and defaults to this session's own.** A model
# that has been running cells in the default all conversation should not have
# to name it to add a package to it — and naming it wrongly is worse than
# omitting it. Resolved through `Confinement.default_for`, the same answer an
# unaddressed cell already gets.
#
# **`packages` may not be empty.** Unlike `create`, where an empty list asks
# for an environment holding only its interpreter, an ADD of nothing is not a
# state anybody can be asking for — so it is refused by value rather than
# turned into a card asking a researcher to approve installing nothing.
#
# **No remove.** The same reasoning as D7's no-delete: what is installed is
# gigabytes on colleagues' machines and is what their notebooks import, and
# taking something out from under them is not a thing to do by conversational
# inference. This is a decision, not an omission.
#
# Its `environment` is written out here rather than reusing `_ENVIRONMENT`,
# which every cell-running tool shares. That object describes which
# environment a cell RUNS in and promises a refusal "rather than run somewhere
# else"; this one describes which environment is CHANGED. Sharing the object
# would put a sentence about running cells on a tool that runs none — the
# drift that constant exists to prevent, arriving from the other direction.
MANAGE_PACKAGES = types.Tool(
    name="manage_packages",
    title="Add packages to an environment",
    description=(
        "Add packages to one of this Task's environments. The researcher is "
        "asked first, because this installs software on every machine in this "
        "lab. What is already declared is kept: this adds, and never removes. "
        "The rebuild runs after this call answers, and every kernel in that "
        "environment is restarted when it finishes — so a package added here "
        "is not importable in the very next cell. Use manage_environments "
        "with action \"list\" to see when it has landed."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "packages": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "The packages to add, by name. At least one — adding "
                    "nothing is not a request this tool takes."
                ),
            },
            "environment": {
                "type": "string",
                "description": (
                    "Which environment to add them to. Omit for this Task's "
                    "own. An environment this Task cannot reach is refused by "
                    "name rather than changed somewhere else."
                ),
            },
        },
        "required": ["packages"],
    },
)

# The one place a language and the tool that runs it are written down together,
# so "can be started" and "is published" cannot drift apart: a language with no
# row here is one no agent is ever offered a way to reach.
_BY_LANGUAGE = {"python": EXECUTE_PYTHON_CELL, "r": EXECUTE_R_CELL}


def tools_for(languages: tuple[str, ...]) -> list[types.Tool]:
    """What this machine publishes: one runner per language it can start a
    kernel in, the shell, and the two tools that answer about environments
    rather than running anything. A machine with no R publishes no
    `execute_r_cell`; every machine publishes the others, since a session
    holds environments whatever this machine can run."""
    return [_BY_LANGUAGE[language] for language in languages if language in _BY_LANGUAGE] + [
        EXECUTE_SHELL_CELL,
        MANAGE_ENVIRONMENTS,
        MANAGE_PACKAGES,
    ]


def _text(arguments: dict[str, Any] | None, key: str) -> str:
    value = (arguments or {}).get(key)
    if not isinstance(value, str):
        raise ValueError(f"this tool needs a {key}")
    return value


def _optional_text(
    arguments: dict[str, Any] | None, key: str, subject: str = "cell"
) -> str | None:
    """A named argument the call did not have to make.

    Absent and null are one answer — the call named nothing and is owed this
    session's default. Anything else that is not a name is refused rather
    than quietly answered with that default: the published description
    promises an environment that does not exist is refused by name rather
    than run somewhere else, and a value that is not a name at all must not
    be the one exception to it.

    Stricter than `host.py`'s namesake on purpose, which answers the same
    shape with the default. What is on the other end of that one is the
    daemon, which wrote the field itself; what is on the other end of this
    one is a model.

    The refusal carries the offending value, because the tool's published
    description promises a refusal *by name* and the agent is the one who has
    to write the next call: told only that a cell names its environment, it
    cannot see which of the things it sent was the thing complained about.

    `subject` is what the refusal calls the thing whose argument this is, so
    a tool that runs no cell does not refuse in the words of one — the same
    argument means "where this cell lands" on a runner and "what is being
    changed" on `manage_packages`, and a sentence naming the wrong one sends
    an agent looking for a mistake it did not make.
    """
    value = (arguments or {}).get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ValueError(f"a {subject}'s {key} is a name, and {value!r} is not one")
    return value


def _action(arguments: dict[str, Any] | None, published: tuple[str, ...]) -> str:
    """Which of the things a tool published a call is asking for.

    Refused by value, the way `_optional_text` refuses one, and refused HERE
    rather than trusted to have been filtered: nothing between a model and
    this handler checks an argument against a schema, so an action a tool
    never named arrives looking exactly like the one it did. An enum of one
    value is still a gate that has to be shut, and an unpublished action that
    fell through to the published one would be a capability nobody offered.

    The refusal carries the offending value and what this tool does instead,
    because the agent wrote the value and is the one who has to write the
    next call.
    """
    value = (arguments or {}).get("action")
    if not isinstance(value, str) or value not in published:
        raise ValueError(
            f"this tool does {' or '.join(published)} and nothing else,"
            f" and {value!r} is not one of those"
        )
    return value


def _environments_read(listed: dict[str, Any]) -> str:
    """What the agent reads back: one line per environment, saying which of
    the phase's three states it is in.

    The unknown one is a line of its own rather than a silence, because
    silence here reads as the list being complete — which for a session whose
    lab was never asked is precisely the thing that is not known.
    """
    lines = []
    for row in listed["environments"]:
        # Two independent facts, written independently: whether this machine
        # built it, and whether anything here knows what language it is in. A
        # line that read the second off the first would raise on a row that
        # broke the pair rather than say what the row actually holds — and
        # what reaches the agent then is a fault in this server instead of an
        # answer.
        named = f"{row['name']} ({row['language']})" if "language" in row else row["name"]
        said = (
            f"{named} — built on this machine"
            if row["builtHere"]
            else f"{named} — declared by this lab, not built on this machine"
        )
        # The one place a model can see that a rebuild it asked for has
        # landed. `manage_packages` answers before the build finishes, so
        # without this the model is told to wait and given nothing to wait
        # for. A row saying this is that build having finished AND this
        # Task's kernels in it having been restarted into it — which is also
        # the moment the packages become importable.
        if "restartedBecause" in row:
            said += (
                f"; this Task's kernels in it were restarted: {row['restartedBecause']}"
            )
        lines.append(said)
    if not lines:
        lines.append("this Task can reach no environments at all")
    if not listed["declarationsKnown"]:
        lines.append(
            "this machine could not reach the lab's own list, so the above is"
            " what it has built rather than everything this lab has declared"
        )
    return "\n".join(lines)


def _listed(reach: Reach) -> types.CallToolResult:
    """Every environment this session can reach, answered from what this host
    already holds.

    No round trip: the confinement the daemon configured this session with
    carries both halves — what this machine built, and every name the lab
    declared — so the answer costs a dict rather than a message to the lab.

    A structured half with no cell in it, because nothing ran. This is the
    one tool here that produces no cell, and inventing an empty one for it
    would put a record of work that never happened in the lab's notebook.
    """
    listed = reach.registry.environments_for(reach.identity.session_id)
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=_environments_read(listed))],
        structuredContent=listed,
    )


def _refused(why: str) -> types.CallToolResult:
    """A call this session cannot reach, answered rather than raised.

    A failed tool call and not a protocol error: the sentence is the whole of
    what the agent needs in order to write the next cell — which of the three
    absences it was, and which name it was about — and a protocol error
    carries it as a fault in this server instead. The same reasoning `_answer`
    already applies to a cell that raised.

    No structured half, because nothing ran. A refusal mints no kernel and
    leaves no cell for the lab to keep, and an empty one invented here would
    be a record of work that never happened.
    """
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=why)], isError=True
    )


def _created_name(arguments: dict[str, Any] | None) -> str:
    """What the environment being created is to be called, refused by value.

    Nothing between a model and this handler checks an argument against a
    schema, so `name` arrives as whatever was sent — including not at all.
    The refusal carries the offending value for the same reason
    `_optional_text`'s does: the agent wrote it and is the one who has to
    write the next call.

    What a name may CONTAIN is the lab's to decide and is refused there, in
    one place, because it is the lab that has to be able to hand the same
    name to every machine as a directory. Refusing a shape here as well would
    be a second copy of that rule, drifting.
    """
    value = (arguments or {}).get("name")
    if not isinstance(value, str) or not value:
        raise ValueError(f"creating an environment needs a name, and {value!r} is not one")
    return value


def _created_packages(arguments: dict[str, Any] | None) -> list[str]:
    """The packages the new environment is to hold.

    An EMPTY list is an answer — an environment holding only its interpreter,
    which is a real thing to ask for. An ABSENT one is not: nobody said what
    this environment is for, and inventing `[]` there would declare an empty
    environment lab-wide because a field was forgotten. So the two are told
    apart here, and the refusal names the spelling that means empty.

    A list holding something that is not a package name is refused whole
    rather than filtered down to the entries that are. A filtered list is a
    declaration nobody wrote, pinned for every machine in the lab, differing
    from what the agent sent in a way nothing reports.
    """
    value = (arguments or {}).get("packages")
    if value is None:
        raise ValueError(
            "creating an environment says which packages it holds — send an empty"
            " list for one holding only its interpreter"
        )
    if not isinstance(value, list) or not all(
        isinstance(package, str) and package for package in value
    ):
        raise ValueError(
            f"an environment's packages are a list of names, and {value!r} is not one"
        )
    return list(value)


async def _created(reach: Reach, arguments: dict[str, Any] | None) -> types.CallToolResult:
    """One environment, declared in this lab — if the researcher allows it.

    Nothing here builds anything. D2: the declaration is the lab's and the
    gigabytes are each machine's, so what this produces is a name this lab
    holds and a session that can see it, not an interpreter on this disk.

    Like `list`, this runs no cell, mints no kernel and takes no place in any
    kernel's queue, so it answers with no `cell`. Unlike `list`, it cannot be
    answered from what this host already holds: raising a card in front of a
    researcher and calling the lab with their token are both the daemon's,
    and this process holds neither.
    """
    try:
        name = _created_name(arguments)
        packages = _created_packages(arguments)
    except ValueError as refused:
        return _refused(str(refused))
    ask = reach.registry.ask_daemon
    if ask is None:
        # A registry nothing connected the second direction of — which every
        # one built directly is. Said out loud, because the alternative is a
        # success reported for a declaration no lab ever heard of.
        return _refused(
            f"this machine's daemon cannot be asked for that, so {name} was not created"
        )
    try:
        # Off the loop, the same way a cell is, and for a longer reason: this
        # waits on a researcher answering a card, which is as long as they
        # take. Run here, this connection could not answer a ping or a
        # cancellation until they had.
        declared = await asyncio.to_thread(
            ask,
            "environment.create",
            {
                # The session this connection is bound to, which is the same
                # one `_listed` answers about. Nothing about a session
                # arrives as an argument — that is what keeps an agent inside
                # the namespaces it was given.
                "session_id": reach.identity.session_id,
                "name": name,
                "packages": packages,
            },
        )
    except Exception as failure:  # noqa: BLE001 - reported, never swallowed
        said = str(failure)
        # The refusal names the environment whatever the daemon said about
        # it: an agent that asked for a name is owed an answer about that
        # name, and a bare "denied" leaves it guessing which of the things it
        # asked for was refused.
        return _refused(said if name in said else f"{name} was not created: {said}")
    return types.CallToolResult(
        content=[
            types.TextContent(
                type="text",
                text=(
                    f"{name} is declared in this lab and is NOT built on this machine"
                    " yet. Nothing was installed by this call. Until somebody builds"
                    f" it here, a cell naming {name} is refused by name rather than"
                    " run somewhere else."
                ),
            )
        ],
        # The declaration whole where the daemon answered with one, and no
        # structured half at all where it did not: a shape invented here
        # would be this server describing a record it never saw.
        structuredContent=({"environment": declared} if isinstance(declared, dict) else None),
    )


def _added_packages(arguments: dict[str, Any] | None) -> list[str]:
    """The packages to add, refused by value.

    An EMPTY list is refused here, which is where this differs from
    `_created_packages`. There, `[]` is a real request — an environment
    holding only its interpreter. Here it asks for nothing to be added to
    something, which is not a state anybody can mean; taken seriously it
    would put a card in front of a researcher asking them to approve
    installing no software, and a rebuild behind their answer.

    A list holding something that is not a package name is refused whole
    rather than filtered down to the entries that are, for the reason a
    create's is: what gets installed on every machine in this lab must be
    what the researcher was shown, and a filtered list is neither what was
    asked for nor what anybody approved.
    """
    value = (arguments or {}).get("packages")
    if not isinstance(value, list) or not value:
        raise ValueError(
            f"adding packages needs at least one package name, and {value!r} is not a list of them"
        )
    if not all(isinstance(package, str) and package for package in value):
        raise ValueError(f"a package list is a list of names, and {value!r} is not one")
    return list(value)


def _addressed_environment(reach: Reach, arguments: dict[str, Any] | None) -> str:
    """Which environment this call is about, refused by name where it is one
    this session cannot reach.

    The default is the session's OWN default for Python, read through
    `Registry.default_environment_for` — which is `Confinement.default_for`,
    the same answer `identity_for` gives a cell that names no environment. A
    second notion of "this Task's environment" would be a tool that adds
    packages somewhere other than where the next cell runs.

    Reachability is `environments_for`'s definition and not a second one: the
    rows it returns are exactly what `list` has already told this agent it can
    reach, so a name it was shown and a name it may address are one set. The
    three absences get the three sentences `identity_for` gives them, for the
    same reason it gives three — which of them it is decides what a researcher
    is told to do about it.

    An R environment is refused by name. There are no R environments this
    phase (D1) and the provisioner's sources are `uv` and PyPI, so the only
    thing that could happen to one is Python packages being added to it.
    """
    named = _optional_text(arguments, "environment", "package change")
    if named is None:
        named = reach.registry.default_environment_for(reach.identity.session_id, "python")
        if named is None:
            raise ValueError(
                "this Task has no Python environment to add packages to, and this call named none"
            )
    listed = reach.registry.environments_for(reach.identity.session_id)
    for row in listed["environments"]:
        if row["name"] != named:
            continue
        # `language` is carried only by a row this machine has actually
        # built; a declared-but-unbuilt row has none, and D1 makes every
        # declaration Python. So a missing language is not an R environment.
        if row.get("language") == "r":
            raise ValueError(
                f"{named} is an R environment, and Lykeion manages Python packages only for now"
            )
        return named
    if not listed["declarationsKnown"]:
        # Nothing here knows what this lab has declared. The machine-scoped
        # sentence is the only one true under both absences — the same
        # reading `identity_for` applies to the same state.
        raise ValueError(f"this machine has no environment named {named}")
    raise ValueError(f"this lab has no environment named {named}")


async def _managed_packages(
    reach: Reach, arguments: dict[str, Any] | None
) -> types.CallToolResult:
    """Packages added to an environment this lab already declares — if the
    researcher allows it.

    Runs no cell, mints no kernel and takes no place in any kernel's queue, so
    it answers with no `cell`. Like `create`, it cannot be answered from what
    this host holds: the card and the lab's token are both the daemon's.

    **It does not wait for the rebuild.** What comes back is the declaration
    as this lab now holds it and whether this lab managed to ASK for a build —
    never a build that has finished, and never a claim that one is under way
    on this disk right now, which nothing here is in a position to know. So
    the answer says exactly that, because a model told "scanpy was added"
    writes `import scanpy` in its very next cell, into a kernel whose
    environment has not been rebuilt yet, and reads the ImportError as its own
    mistake — and it points the model at `manage_environments`'s list, which
    is where the rebuild becomes observable.
    """
    try:
        packages = _added_packages(arguments)
        name = _addressed_environment(reach, arguments)
    except ValueError as refused:
        return _refused(str(refused))
    ask = reach.registry.ask_daemon
    if ask is None:
        # A registry nothing connected the second direction of. Said out
        # loud, because the alternative is a success reported for software no
        # lab ever heard of and no machine will ever build.
        return _refused(
            f"this machine's daemon cannot be asked for that, so nothing was added to {name}"
        )
    try:
        # Off the loop, the same way `_created` is, and for the same reason:
        # this waits on a researcher answering a card, which is as long as
        # they take.
        answered = await asyncio.to_thread(
            ask,
            "environment.add_packages",
            {
                # The session this connection is bound to. Nothing about a
                # session arrives as an argument — that is what keeps an
                # agent inside the namespaces it was given.
                "session_id": reach.identity.session_id,
                "name": name,
                "packages": packages,
            },
        )
    except Exception as failure:  # noqa: BLE001 - reported, never swallowed
        said = str(failure)
        # The refusal names the environment whatever the daemon said about
        # it: the agent asked about a name and has to write the next call.
        return _refused(said if name in said else f"nothing was added to {name}: {said}")
    record = answered if isinstance(answered, dict) else {}
    added = record.get("added")
    added = [entry for entry in added if isinstance(entry, str)] if isinstance(added, list) else None
    # Read, not merely carried through in the structured half. The lab
    # publishes this because only the lab knows whether it managed to ask a
    # machine for a build; a sentence that assumed one every time `added` was
    # non-empty would be this end guessing at the one fact the answer exists
    # to report. Three states, three sentences.
    building = record.get("building") is True
    if added is not None and not added:
        # Everything asked for was already declared. Not an error — it is the
        # state the caller asked for, already reached — but it must not be
        # reported as a change, because nothing was written.
        #
        # Whether anything is BEING REBUILT is a separate fact, and this branch
        # must read it rather than assume it. The lab dispatches a build on an
        # empty `added` when its pin no longer answers the declaration, which
        # is the state a failed build leaves — the package is declared and no
        # machine holds it. That is the retry an agent has, and telling it
        # "nothing is being rebuilt" there would send it away from the one
        # call that recovers the environment.
        said = (
            f"{name} already declares {', '.join(packages)} and nothing was added to this"
            f" lab's list. This lab HAS asked this machine to rebuild {name}, because its"
            f" build here is behind what {name} declares — an earlier build may have"
            f" failed. That build had NOT finished when this call answered, so importing"
            f" {', '.join(packages)} may still fail for now. Call manage_environments with"
            " action \"list\" to find out when it has landed."
        ) if building else (
            f"{name} already holds {', '.join(packages)}. Nothing was added and nothing is"
            " being rebuilt."
        )
    else:
        spoken = ", ".join(added) if added else ", ".join(packages)
        # What is actually known, and no more. This lab ASKED a machine to
        # rebuild; nothing here waited for that build, and nothing here can
        # see whether it has started — so "rebuilding NOW" would be a sentence
        # stronger than the fact, and flatly false for an add that joined a
        # build already in flight.
        #
        # And the model is told where to look. It is told to wait, so it has
        # to be given something to wait FOR: `manage_environments` with
        # `action: "list"` names an environment as restarted, and why, once
        # the build has landed and this Task's kernels have been put back into
        # it — which is the same moment the packages become importable.
        said = (
            f"{spoken} added to {name} in this lab. This lab has asked this machine to rebuild"
            f" {name}; that build had NOT finished when this call answered, so importing"
            f" {spoken} will still fail for now. Call manage_environments with action \"list\""
            f" to find out when it has: {name} says there that this Task's kernels were"
            " restarted, and why."
        ) if building else (
            f"{spoken} added to {name} in this lab. No rebuild was started for it here, so"
            f" nothing on this machine holds {spoken} yet — it is built the next time"
            f" {name} is set up on this machine."
        )
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=said)],
        # The lab's own record where the daemon answered with one, and no
        # structured half at all where it did not: a shape invented here
        # would be this server describing a record it never saw.
        structuredContent=(answered if isinstance(answered, dict) else None),
    )


# The keys a caller's own id for this call is looked for under, in the order
# they are tried. Claude Code forwards its tool-use id under a vendor key;
# the bare spellings are for any adapter that says the same thing plainly.
TOOL_USE_ID_KEYS = ("claudecode/toolUseId", "toolUseId", "toolCallId")


def tool_use_id_from(meta: Any) -> str | None:
    """The caller's own id for this call, when its `_meta` carried one.

    A provider that forwards its tool-use id here names the very record its
    transcript keeps for the call, so the cell and that record can be read as
    one event. Absent, non-string, or empty is answered with None rather than
    a guess — the daemon may still join the cell to its step by observation.
    """
    for key in TOOL_USE_ID_KEYS:
        value: Any = None
        if isinstance(meta, dict):
            value = meta.get(key)
        elif meta is not None:
            value = getattr(meta, key, None)
            if value is None:
                extra = getattr(meta, "model_extra", None)
                if isinstance(extra, dict):
                    value = extra.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def cell_for(reach: Reach, source: str, tool_use_id: str | None) -> dict[str, Any]:
    """One cell, run in the kernel this server is bound to."""
    return reach.registry.execute(
        reach.identity,
        source,
        origin={"surface": "agent", "by": reach.agent},
        tool_use_id=tool_use_id,
    )


def server_for(reach: Reach) -> Server[Any]:
    """The MCP server one connection is answered by."""
    # Settled when the connection is answered rather than per call: what this
    # machine can run was resolved once, when the host started, and a set built
    # on every call would be the same set every time.
    published = tools_for(tuple(runnable.language for runnable in reach.registry.runnables))
    named = {tool.name for tool in published}
    runners = {tool.name: language for language, tool in _BY_LANGUAGE.items()}
    # Which tools may be addressed at an environment, read off the very
    # schemas that were just handed to the agent rather than off a list of
    # names kept beside them. Nothing between a model and this handler checks
    # an argument against a schema, so an unpublished property arrives looking
    # exactly like a published one: reading it everywhere would make
    # `execute_r_cell` honour an argument it never offered — a working
    # capability behind an unpublished surface, which is this machine's
    # reachability rule in reverse. Off the schema and not off a tool's name,
    # because the schema is the single statement of what a tool accepts, so a
    # tool that gains or loses the property says so once and in one place.
    addressable = {
        tool.name
        for tool in published
        if "environment" in tool.input_schema.get("properties", {})
    }
    # And which actions each tool that takes one published, read off the same
    # schemas for the same reason: the enum an agent was shown is the whole of
    # what it may ask for, and it is written once, where the tool is.
    actions = {
        tool.name: tuple(tool.input_schema["properties"]["action"].get("enum", ()))
        for tool in published
        if "action" in tool.input_schema.get("properties", {})
    }

    async def on_list_tools(
        _ctx: Any, _params: types.PaginatedRequestParams | None
    ) -> types.ListToolsResult:
        return types.ListToolsResult(tools=published)

    async def on_call_tool(
        _ctx: Any, params: types.CallToolRequestParams
    ) -> types.CallToolResult:
        if params.name not in named:
            raise ValueError(f"this machine publishes no tool named {params.name}")
        # Answered before anything about cells is read, because neither of
        # this tool's actions runs one: they take no code, mint no kernel and
        # take no place in a queue. `list` is answered from the confinement
        # this session was configured with — both what this machine built and
        # every name the lab declared are already here, so an agent asking
        # what exists needs no round trip at all. `create` is the one that
        # leaves this process, because a card and the lab's token are the
        # daemon's rather than this host's.
        if params.name == MANAGE_ENVIRONMENTS.name:
            try:
                action = _action(params.arguments, actions[params.name])
            except ValueError as refused:
                return _refused(str(refused))
            if action == "create":
                return await _created(reach, params.arguments)
            return _listed(reach)
        # Answered here for the same reason: it runs no cell either. Its
        # `environment` is resolved by `_addressed_environment` rather than by
        # the `addressable` set below — that one is about which kernel a cell
        # lands in, and this tool starts none.
        if params.name == MANAGE_PACKAGES.name:
            return await _managed_packages(reach, params.arguments)
        # Which language a call runs in is the tool's own name. A model picks
        # it the way it picks any tool and there is no enum it can get wrong —
        # a wrong enum would mint a real cell in the wrong namespace, with a
        # syntax error as its output. The shell runs in the Python kernel,
        # inside the same boundary and the same Task directory.
        if params.name == "execute_shell_cell":
            source = shell_source(_text(params.arguments, "command"))
            language = "python"
        else:
            source = _text(params.arguments, "code")
            language = runners[params.name]
        # `replace(reach.identity, language=language)` alone would carry the
        # OLD language's environment over onto the new one — Python's default
        # onto an R cell — and a mismatched pair is refused as unconfined
        # rather than started. Resolved afresh through the same call `Reach`
        # itself was built with, so a cell in a language other than the
        # connection's own still lands in that language's own default.
        #
        # And afresh whenever the call named an environment, on either branch:
        # the shell's language is decided here rather than by the tool's own
        # name, so an environment resolved only on the other branch would
        # leave every shell cell in the default however it was addressed.
        # `None` means the call named none — which is also what a call to a
        # tool that publishes no such argument means, however it was spelled —
        # and `identity_for` answers it with this session's default for the
        # language, the identity the connection was built with, resolved the
        # same way.
        #
        # Resolved before a place is taken and before a kernel is minted, so a
        # name this session cannot reach costs a sentence rather than an entry
        # on a researcher's machine for a kernel that never started.
        try:
            environment = (
                _optional_text(params.arguments, "environment")
                if params.name in addressable
                else None
            )
            identity = (
                reach.identity
                if environment is None and language == reach.identity.language
                else reach.registry.identity_for(
                    reach.identity.session_id, reach.identity.task_id,
                    reach.identity.name, language, environment,
                )
            )
        except ValueError as refused:
            return _refused(str(refused))
        tool_use_id = tool_use_id_from(getattr(params, "meta", None))
        # Off the loop, because a cell holds whatever is running it for as
        # long as it runs. Run here, this connection could not answer a ping
        # or a cancellation for the length of a researcher's slowest cell.
        return _answer(
            await asyncio.to_thread(
                cell_for, replace(reach, identity=identity), source, tool_use_id
            )
        )

    return Server(
        "notebook",
        version="1",
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
