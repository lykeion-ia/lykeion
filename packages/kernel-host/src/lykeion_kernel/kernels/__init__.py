"""What every kernel implementation is handed, whatever language it runs."""

from __future__ import annotations

from dataclasses import dataclass


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
