"""What a kernel's process is using, as far as this platform will say.

Every psutil call in this package is here. The rest of the host asks this
module and gets a `Sample`, whose fields are `None` when nobody could say —
which is a different fact from a process measured at zero, and the one the
whole Runtimes screen is built to keep apart.
"""

from __future__ import annotations

from dataclasses import dataclass

import psutil

# What psutil raises when a process has gone, or when this platform will not
# describe it. Caught identically everywhere: both mean "no measurement", and
# a caller has nothing different to do about them.
UNREADABLE = (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess)


def total_memory() -> int:
    """This machine's total memory, in bytes.

    Not one kernel's process family but the whole machine those families
    share — the figure `reclaim()`'s pressure policy judges against. Kept
    here rather than read where it is used, so the module's own opening
    claim, that every `psutil` call in this package is here, stays true
    instead of quietly growing an exception.
    """
    return psutil.virtual_memory().total


@dataclass(frozen=True)
class Sample:
    """One reading. `None` is absent; `0` is a measurement."""

    memory_bytes: int | None = None
    cpu_percent: float | None = None


class Probe:
    """One kernel's process family, held across readings.

    Held rather than reconstructed because `cpu_percent()` measures against
    its own previous call on the same object. A fresh handle every tick would
    report the average since the process started, which on a kernel that has
    been up for an hour is a number that cannot move.
    """

    def __init__(self, pid: int) -> None:
        self._pid = pid
        self._seen: dict[int, psutil.Process] = {}
        try:
            self._prime(psutil.Process(pid))
        except UNREADABLE:
            # A kernel can die between the launch that returned this pid and
            # the first tick that reads it. That is a probe that reports
            # nothing, not a host that fails to start one.
            return

    def _prime(self, process: psutil.Process) -> None:
        """Registers a process and starts its CPU interval.

        The first `cpu_percent()` on a handle returns the average since the
        process began and is discarded rather than reported: it is not a
        reading of the interval this probe exists to measure.
        """
        self._seen[process.pid] = process
        try:
            process.cpu_percent()
        except UNREADABLE:
            return

    def sample(self) -> Sample:
        """This family's memory and processor use, or absent for both."""
        root = self._seen.get(self._pid)
        if root is None:
            return Sample()
        try:
            family = [root, *root.children(recursive=True)]
        except UNREADABLE:
            return Sample()

        memory = 0
        cpu = 0.0
        measured = False
        for process in family:
            known = process.pid in self._seen
            if not known:
                # Newly forked. Its memory counts immediately; its processor
                # use has no interval to be measured over yet and joins on the
                # next tick.
                self._prime(process)
            try:
                memory += process.memory_info().rss
                if known:
                    cpu += self._seen[process.pid].cpu_percent()
                measured = True
            except UNREADABLE:
                continue

        if not measured:
            return Sample()
        return Sample(memory_bytes=memory, cpu_percent=cpu)
