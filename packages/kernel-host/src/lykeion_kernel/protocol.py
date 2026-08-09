"""Framing between this machine's daemon and this process.

One JSON object per line, in both directions. Line-delimited rather than
length-prefixed because both ends already have to read this stream by hand,
and a framing a person can read in a log is one they can debug at three in
the morning.
"""

from __future__ import annotations

import json
import threading
from typing import Any, IO, Iterator

PROTOCOL_VERSION = 1

# One writer at a time. Everything a host answers goes onto a single stream
# the other end reads a line at a time, so two of them written together must
# not become one line neither is on: a partial line is worse than a delayed
# one, because it is a parse error that discards a message nothing resends.
_writing = threading.Lock()


def write_message(stream: IO[str], message: dict[str, Any]) -> None:
    """One message on the stream, whole, whichever thread is writing it."""
    line = json.dumps(message, separators=(", ", ": ")) + "\n"
    with _writing:
        stream.write(line)
        stream.flush()


def read_messages(stream: IO[str]) -> Iterator[dict[str, Any]]:
    """Every well-formed object on the stream, in order.

    A line that will not parse, or that parses to something other than an
    object, is skipped. The daemon writing one has a defect; a host that
    exited on it would turn that defect into a machine holding no kernels,
    which is a much larger failure than the one that caused it.
    """
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if isinstance(message, dict):
            yield message
