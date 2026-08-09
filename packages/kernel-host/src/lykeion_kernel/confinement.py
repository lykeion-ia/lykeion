"""The boundary a kernel runs inside, as this process receives it.

Nothing here builds one. The daemon renders the policy and hands over an
argv prefix already assembled; this module concatenates an interpreter's
argument list onto it and refuses when it was given none. There is no branch
that produces an unconfined command, because there is nothing here that
could construct the rule such a command would be missing.
"""

from __future__ import annotations


def confined(prefix: list[str], argv: list[str]) -> list[str]:
    if not prefix:
        raise ValueError("no confinement was supplied for this kernel")
    return [*prefix, *argv]
