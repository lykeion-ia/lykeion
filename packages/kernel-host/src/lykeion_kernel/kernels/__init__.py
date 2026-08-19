"""What every kernel implementation is handed, whatever language it runs."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol

# The variables a kernel is never allowed to inherit. Every one of them names
# an environment, and the environment this host process is running in is not
# the one a kernel is in. A name that is wrong is worse than no name at all:
# `pip`, `uv`, `conda` and `mamba` each read one of these and act on it, and
# not one of them can tell that the environment it names is stale.
#
# `PIP_PREFIX` is the fourth, and it is here for a slightly different reason
# from the three above it: not that it names the wrong environment, but that
# it names one AT ALL alongside the `PIP_TARGET` `launch_env` writes for every
# Python kernel. pip refuses the pair outright — `ERROR: Cannot set --home and
# --prefix together` — so a researcher with `PIP_PREFIX` exported in their own
# shell profile breaks EVERY inline install in Lykeion, with a message that
# has no relation to anything they typed. Removed rather than overridden,
# because there is no value of it that could be right: the answer to "where
# does an install in a cell land" is the overlay, and that is `PIP_TARGET`'s
# to say.
#
# `R_LIBS_USER`, `R_LIBS` and `R_LIBS_SITE` are R's own three, and the harm
# they do is narrower than the six above — none of them names an environment
# at all. `install.packages()` writes to `R_LIBS_USER` and `library()` reads
# all three, so a value inherited from the researcher's own shell profile
# puts their personal library on `.libPaths()` inside an environment that is
# supposed to be pinned — and a script that works here only because THIS
# machine happens to hold a package in that library is the exact
# irreproducibility a built R environment exists to remove. Effaced here
# rather than left to whatever boundary the daemon renders around the
# kernel, because a variable arrives by INHERITANCE: a boundary can deny a
# researcher's home as a path and still do nothing to stop `R_LIBS_USER`
# from being SET to a path inside it, which is what this list is for.
EFFACED = (
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "CONDA_DEFAULT_ENV",
    "PIP_PREFIX",
    "R_LIBS_USER",
    "R_LIBS",
    "R_LIBS_SITE",
)


def environment_of(interpreter: str, inherited: Mapping[str, str]) -> dict[str, str]:
    """The whole environment a kernel started with `interpreter` is given.

    The finished mapping, and deliberately not an overlay for a caller to
    spread over `inherited` — because half of this answer is what must be
    TAKEN AWAY, and a spread cannot delete a key. A launcher holding its own
    removal literal beside this one goes stale the moment this learns about
    another variable, which is exactly how `CONDA_PREFIX` came to be missed
    while `VIRTUAL_ENV` was handled.

    A right `sys.executable` is not enough. `pip`, `uv`, `conda` and anything
    a researcher shells out to read `PATH`, `VIRTUAL_ENV` and `CONDA_PREFIX`
    and act on them — so a kernel handed this host's own would install into
    Lykeion's own installation while reporting it ran somewhere else. Naming
    an environment has to mean the whole environment, not the interpreter
    alone.

    What is derived:

    - `PATH` leads with the interpreter's own directory. Prepended, never
      replacing: a cell is still on this machine and still needs the tools
      the researcher installed on it. What changes is which `python3`
      answers first.
    - `VIRTUAL_ENV` only where the root really is a virtualenv — the
      `pyvenv.cfg` beside it is the test, not the shape of the path.
    - `CONDA_PREFIX` the same way, on a `conda-meta` directory at the root,
      which is the mark conda leaves and the symmetric test.

    Everything else in `EFFACED` is removed rather than passed on —
    `CONDA_DEFAULT_ENV` in both branches, including the conda one. Conda's
    own name for an environment is not derivable from its prefix (a `-p`
    environment is named by its whole path, a `-n` one by a directory under
    `envs`), and this would rather say nothing than guess a name every
    `conda` subcommand would then act on.

    `PYTHONHOME` and `PYTHONPATH` are NOT swept, which is a judgement rather
    than an oversight and the weaker half of this function. `PYTHONHOME`
    pointed at an installation of another minor version fails loudly at
    startup — that is the common case, not a guarantee: pointed at a
    same-minor installation it silently supplies that installation's stdlib
    to every kernel. `PYTHONPATH` is a legitimate thing for a researcher to
    set on their own machine, where removing it would take away something
    they asked for. Both belong to sanitising an inheritance rather than to
    naming an environment, which is what this is.
    """
    # Absolute but NOT resolved. A virtualenv's `bin/python3` is a symlink to
    # the interpreter it was built from, so following it lands in the base
    # installation's own `bin` — the one directory this must never name,
    # since `pip` and `pip3` live there too and a cell's `pip install` would
    # then write into the uv-managed CPython every venv on this machine was
    # built from. What is wanted is the directory the link is IN.
    home = Path(os.path.abspath(interpreter)).parent
    root = home.parent
    described = {name: value for name, value in inherited.items() if name not in EFFACED}
    # Every empty component is dropped, not merely the case where the whole
    # inherited `PATH` is empty. On POSIX an empty `PATH` component means THE
    # CURRENT DIRECTORY — and a kernel's current directory is the workspace,
    # i.e. content the agent itself may have just written, reached by every
    # bare command name a cell runs. Guarding only the wholly-empty case
    # covered the rarer half: the way this actually arises is a shell profile
    # doing `PATH=$PATH:$SOMETHING` with `$SOMETHING` unset, which leaves
    # `/usr/bin:` — inherited, non-empty, and carrying the workspace anyway.
    #
    # This sanitises the `PATH` this function builds, and claims nothing
    # wider about the inheritance: that line is where `PYTHONHOME` and
    # `PYTHONPATH` are left alone, and it has not moved.
    carried = [
        part for part in (inherited.get("PATH") or "").split(os.pathsep) if part
    ]
    described["PATH"] = os.pathsep.join([str(home), *carried])
    if (root / "pyvenv.cfg").exists():
        described["VIRTUAL_ENV"] = str(root)
    if (root / "conda-meta").is_dir():
        described["CONDA_PREFIX"] = str(root)
    return described


@dataclass(frozen=True)
class KernelIdentity:
    """What makes two kernels different things.

    A context owns one kernel per language it runs code in, and `task_id` is
    in here because the boundary a kernel runs inside is rendered for one
    Task directory: a kernel whose Task were left implicit would have a
    working directory decided by whichever Task its session happened to run
    first.
    """

    session_id: str
    task_id: str
    name: str
    language: str
    # In the identity because two environments are two interpreters, which
    # are two processes, which are two namespaces. A kernel whose
    # environment were left implicit would run in whichever one its session
    # happened to configure first — the same reason `task_id` is here.
    environment: str


class Kernel(Protocol):
    """What the registry holds, whatever language is behind it.

    Written down rather than introduced: `PythonKernel` satisfies every member
    of this today and the registry already calls exactly these. What it buys is
    a second implementation that cannot quietly differ from the first.
    """

    @property
    def pid(self) -> int: ...

    @property
    def start_token(self) -> str: ...

    def alive(self) -> bool: ...

    def execute(self, source: str) -> dict[str, Any]: ...

    def interrupt(self) -> None: ...

    def stop(self) -> None: ...

    def stderr_tail(self) -> str: ...
