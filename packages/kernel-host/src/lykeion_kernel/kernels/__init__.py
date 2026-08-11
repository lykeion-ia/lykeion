"""What every kernel implementation is handed, whatever language it runs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


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
