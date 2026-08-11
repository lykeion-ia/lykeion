"""What this machine can run, resolved once when the host starts.

The daemon renders every boundary and can work none of this out: which
interpreter this process resolved is a fact about how it was started, and the
file a kernel is told to run is a fact about this package. So they are
reported rather than guessed at.

One entry per language this machine has an interpreter for. A language absent
from this list is one the host publishes no tool for, offers no chip for, and
refuses a cell addressed to — one absence, in one place, rather than a list of
names kept beside the thing that can actually start a process.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .kernels.python import DRIVER as PYTHON_DRIVER
from .kernels.r import DRIVER as R_DRIVER


# How long this machine's R is given to say where it keeps itself.
#
# Bounded because of where this runs, not because of what it costs. It is
# asked from Registry.__init__, which serve() calls BEFORE the loop that reads
# the daemon's messages — so an Rscript that never returns is not a slow
# answer, it is a host that never answers anything at all. No host.hello, the
# daemon's own reach deadline expires, and every Task opened on this machine
# comes up with no kernels — including Python ones, which have nothing to do
# with R. The host is never restarted, by design, so that state lasts as long
# as the machine is up. The ways R hangs here are ordinary: a `.libPaths()`
# entry on an unreachable network mount, an installation caught mid-upgrade.
#
# Measured on this machine's homebrew R 4.6.1 at 0.11-0.21s over three cold
# runs, so ten seconds is close to two orders of magnitude of headroom for a
# slower disk or a longer library list, and still a ninth of the ninety
# seconds the daemon gives the whole reach. What it buys is that a wedged R
# costs this host ten seconds and one language rather than every language on
# the machine.
R_ASK_S = 10.0


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


def _r() -> Runnable | None:
    """R, only where this machine has it.

    Reads are asked of R itself. `.libPaths()` is not optional and not
    derivable: on a homebrew install it returns a site-library outside
    `R.home()`, and a boundary built from `R.home()` alone would deny every
    package a researcher ever installed. It may name a directory under the
    researcher's home, and this grants it — `readable` is read-only by
    construction, and this is the same category as `sys.prefix` for Python.
    """
    rscript = shutil.which("Rscript")
    if rscript is None:
        return None
    try:
        asked = subprocess.run(
            [rscript, "--vanilla", "-e", "cat(c(R.home(), .libPaths()), sep='\\n')"],
            capture_output=True,
            text=True,
            check=False,
            timeout=R_ASK_S,
        )
    except subprocess.TimeoutExpired:
        # run() kills the child and waits for it before raising, so nothing is
        # left behind on the machine holding this host's pipes open.
        _unusable(rscript, f"it did not answer in {R_ASK_S:g}s and was killed")
        return None
    except OSError as refused:
        # which() found it and the platform would not start it: a file that
        # lost its execute bit, a mount that went away between the two calls.
        _unusable(rscript, f"this machine would not start it: {refused}")
        return None
    if asked.returncode != 0:
        said = asked.stderr.strip() or "saying nothing"
        _unusable(rscript, f"it exited {asked.returncode}: {said}")
        return None
    named = [
        rscript,
        *[line for line in asked.stdout.splitlines() if line],
        str(Path(R_DRIVER).parent),
    ]
    return Runnable(
        language="r",
        interpreter=rscript,
        environment="r",
        reads=tuple(dict.fromkeys(named)),
    )


def _unusable(rscript: str, why: str) -> None:
    """Says why a machine that has R is nonetheless going to hold no R kernels.

    Written to stderr and never to stdout, which is the protocol this host
    speaks to the daemon over: a sentence on that stream is a message the
    daemon cannot read. The daemon keeps a tail of this one against the host
    it started, so this line is the only place the difference between "this
    machine has no R" and "this machine's R is broken" is recorded at all —
    everywhere above here the two arrive as the identical empty list, and a
    researcher opening a Task sees the same missing chip either way.
    """
    print(f"this machine has {rscript} but will hold no R kernels: {why}", file=sys.stderr)


def runnables(interpreter: str = sys.executable) -> tuple[Runnable, ...]:
    """Every language this machine can run. Python is always among them: it is
    the interpreter this host is itself running in. R is there when the machine
    has one — resolved once, here, so installing R under a running host
    produces no R kernel until that host restarts."""
    found = [_python(interpreter)]
    r = _r()
    if r is not None:
        found.append(r)
    return tuple(found)
