"""What a test needs in order to put a real interpreter behind a kernel.

Every kernel these tests start is a process on the machine running them, so
the fixture that hands one out is also the thing that ends it. A suite that
goes green while interpreters keep running is not a suite that passed.
"""

from __future__ import annotations

import io
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterator, NamedTuple

import pytest

from lykeion_kernel.host import serve
from lykeion_kernel.registry import Registry


@pytest.fixture
def prefix() -> list[str]:
    """An argv prefix that runs whatever it is handed.

    A real one is rendered by this machine's daemon and describes a boundary
    this process has no way to express. What is asserted here is the other
    half of that arrangement: an interpreter's arguments are concatenated
    onto whatever arrived, and a kernel with nothing to concatenate onto is
    not started at all.
    """
    return ["/usr/bin/env"]


@pytest.fixture
def registry(prefix: list[str]) -> Iterator[Registry]:
    """A registry whose kernels have all ended by the time the test returns."""
    holding = Registry(prefix)
    try:
        yield holding
    finally:
        holding.shutdown()


@pytest.fixture
def unconfined_registry() -> Iterator[Registry]:
    """A host that was handed no prefix, which is what `serve()` builds.

    Every boundary it holds arrives from the daemon afterwards, one session
    at a time. A session it was never told about is one whose kernels it
    cannot start.
    """
    holding = Registry([])
    try:
        yield holding
    finally:
        holding.shutdown()


class Spoken(NamedTuple):
    """A live host and what a test does with one: say something, wait for
    something, read the answer to one request, and read everything said."""

    send: Callable[[dict], None]
    until: Callable[..., Any]
    reply: Callable[[int], dict | None]
    lines: list[dict]


@pytest.fixture
def spoken(tmp_path: Path) -> Iterator[Spoken]:
    """A host on a pipe pair, spoken to the way the daemon speaks to one.

    Its own stdio and its own thread, so what a test observes is the loop:
    a handler called directly says nothing about whether a second message
    could have been read while the first was still running.

    Given no registry, which is what its own `main()` builds — every
    boundary it holds arrives over the wire afterwards. Given a store root,
    which that `main()` does NOT: a host builds its own store where this
    machine keeps its records, and a suite writing there would leave a
    researcher's own directory holding the cells of every test run.
    """
    to_host_r, to_host_w = os.pipe()
    from_host_r, from_host_w = os.pipe()
    # Written through rather than buffered, which is what a host started with
    # an unbuffered environment has for a stdout — and the shape where a
    # message longer than the pipe will hold reaches it in more than one
    # piece. A suite that only ever handed this a buffered stream would be
    # asserting nothing about two answers written at once.
    answers = io.TextIOWrapper(io.FileIO(from_host_w, "w"), write_through=True)
    host = threading.Thread(
        target=serve,
        args=(os.fdopen(to_host_r), answers),
        kwargs={"store_root": tmp_path / "provenance"},
        daemon=True,
    )
    host.start()
    stdin = os.fdopen(to_host_w, "w")
    stdout = os.fdopen(from_host_r)
    lines: list[dict] = []

    def read() -> None:
        # Every line parsed on its own, so a message the host wrote in halves
        # is this thread raising rather than a discrepancy noticed much later.
        for line in stdout:
            lines.append(json.loads(line))

    threading.Thread(target=read, daemon=True).start()

    def send(message: dict) -> None:
        stdin.write(json.dumps(message) + "\n")
        stdin.flush()

    def until(predicate: Callable[[], Any], what: str, seconds: float = 10.0) -> Any:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            found = predicate()
            if found:
                return found
            time.sleep(0.01)
        raise AssertionError(f"never saw {what}; lines so far: {lines}")

    def reply(request_id: int) -> dict | None:
        return next((line for line in lines if line.get("id") == request_id), None)

    try:
        yield Spoken(send, until, reply, lines)
    finally:
        # Its stdin closing is how a daemon ends a host, and a host that did
        # not return from it is one this suite would leave interpreters behind.
        stdin.close()
        host.join(timeout=30.0)
        # The reading end is left to the host's own stream ending, because
        # closing one out from under the thread blocked on it waits for the
        # read this suite is trying to finish.
        assert not host.is_alive(), "this host did not stop when its stdin did"


@pytest.fixture
def until() -> Callable[..., None]:
    """Waits for something another thread or another process has to do.

    Fails naming what it was waiting for rather than hanging, so a kernel
    that never reaches the state a test is about is a failure a person can
    read instead of a suite that stops.
    """

    def wait(condition: Callable[[], bool], reason: str, seconds: float = 10.0) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.01)
        raise AssertionError(f"waited {seconds}s for {reason} and it never happened")

    return wait
