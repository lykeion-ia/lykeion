"""What this machine can run before any session has told it anything,
resolved once when the host starts.

The daemon renders every boundary and can work none of this out: which
interpreter this process resolved is a fact about how it was started, and the
file a kernel is told to run is a fact about this package. So they are
reported rather than guessed at.

One entry per language this host can start WITHOUT a session's own built
environment — today, only Python, the interpreter this host is itself
running in, and what an unconfigured session's kernels fall back to
(`Registry._unconfigured`). A language absent from this list is no longer
necessarily a language refused: R has no row here at all and is still
reachable end to end — `Registry.capable_languages` offers it to an agent
regardless (capability in principle, not this list), and
`Registry._runnable_for` is what then lets an actual cell reach the built
environment its own session's confinement names on `kernel.configure_session`.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

from .kernels.python import DRIVER as PYTHON_DRIVER


@dataclass(frozen=True)
class Runnable:
    """One language this machine can hold a kernel in."""

    language: str
    interpreter: str
    environment: str
    # Every place a kernel of this language must be able to read in order to
    # start at all. Ordered, and the interpreter is first: the rest are what it
    # is built out of, and a boundary is written where the operating system
    # will look, which is where the link lands.
    reads: tuple[str, ...]


def _python(interpreter: str) -> Runnable:
    named = [interpreter, sys.prefix, sys.base_prefix, str(Path(PYTHON_DRIVER).parent)]
    return Runnable(
        language="python",
        interpreter=interpreter,
        environment="python",
        reads=tuple(dict.fromkeys(named)),
    )


# R is no longer discovered from the machine.
#
# `_r()` used to manufacture an environment named `r` from the mere presence
# of `Rscript`, and report it built. That name now belongs to a declaration
# the lab makes and each machine provisions, so a discovered interpreter
# answering to it would run a cell in an unpinned R while the screens said
# `r` — two different things wearing one name, which is exactly what D2's
# lockfile identity exists to prevent.
#
# A machine's R now reaches a cell only through a built environment root,
# whose interpreter and reads the daemon names on `kernel.configure_session`.
def _r() -> Runnable | None:
    return None


def runnables(interpreter: str = sys.executable) -> tuple[Runnable, ...]:
    """Every language this host can start WITHOUT a session's own built
    environment. Python, always: it is the interpreter this host is itself
    running in. R is never among them — see `_r` — so a machine installing R
    changes nothing here; only a lab's declaration and this machine building
    it can put R within a cell's reach."""
    return (_python(interpreter),)
