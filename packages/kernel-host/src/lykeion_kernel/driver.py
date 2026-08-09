"""The code a kernel process itself runs: one namespace, one cell at a time.

Started inside the boundary the daemon rendered and spoken to over its own
stdin and stdout, one JSON object per line each way. It imports nothing of
the package it sits in, because the only file a confined interpreter is
certain to be able to read is the one it was told to run.

A cell is compiled as an expression first and as statements otherwise, so a
cell that is one expression shows what it evaluated to. What a cell raises
is reported and never fatal: an interpreter that died of a researcher's
typo would take a whole afternoon's variables with it. That holds for the
code a cell runs, for the code that displays what it produced, and for the
code that describes what it raised — all three are the researcher's.
"""

from __future__ import annotations

import io
import json
import signal
import sys
import traceback
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from types import CodeType
from typing import Any, Callable, Iterator


class _Recorded(io.TextIOBase):
    """One of a cell's streams, writing into the record of both.

    Both streams append to a single list, so a cell that prints, warns and
    prints again is read back in the order it wrote rather than in the order
    two separate buffers happen to be drained.
    """

    def __init__(self, name: str, written: list[tuple[str, str]]) -> None:
        self._name = name
        self._written = written

    @property
    def encoding(self) -> str:
        return "utf-8"

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        if text:
            self._written.append((self._name, text))
        return len(text)


def _compiled(source: str) -> tuple[CodeType, bool]:
    """A cell as one expression when it is one, and as statements otherwise.

    The second compile is outside the handler for the first, so a cell that
    is neither reports the syntax error it has rather than that one under a
    note about the expression it was never trying to be.
    """
    try:
        return compile(source, "<cell>", "eval"), True
    except SyntaxError:
        pass
    return compile(source, "<cell>", "exec"), False


def _rendered(render: Callable[[], str], of: str) -> str:
    """What a cell's own code says about one of its values, when it will say
    anything at all.

    `__repr__` and `__str__` are the researcher's code too, and a half-written
    one is the ordinary state of a class in the middle of a session. A kernel
    that ended while displaying a value would take an afternoon's variables
    with it over a method it was only being asked to print something with.

    The name in the placeholder is guarded on its own. `__name__` is a
    metaclass property when a researcher writes one, which is the same kind of
    code that failed a moment ago — asking it here would raise out of the
    handler that exists to survive exactly that, and the process would end
    holding the namespace.
    """
    try:
        return render()
    except BaseException as bad:  # noqa: BLE001 - a rendering that fails is not fatal
        try:
            named = type(bad).__name__
        except BaseException:  # noqa: BLE001 - naming a failure is not fatal either
            named = "something this kernel cannot name"
        return f"<{of} this kernel could not render: {named}>"


def _error(raised: BaseException, tb: Any) -> dict[str, Any]:
    # Every one of these runs the researcher's own code: the name comes off a
    # class they wrote and may be a metaclass property, `str` is a method they
    # wrote, and the traceback calls `str` again on everything it names. None
    # of the three is allowed to be what ends the kernel.
    name = _rendered(lambda: type(raised).__name__, "a failure")
    evalue = _rendered(lambda: str(raised), f"a {name}")
    rendered = _rendered(
        lambda: "".join(traceback.format_exception(type(raised), raised, tb)).rstrip("\n"),
        "a traceback",
    )
    return {
        "kind": "error",
        "ename": name,
        "evalue": evalue,
        "traceback": rendered.split("\n"),
    }


@contextmanager
def _interruptible() -> Iterator[None]:
    """A signal ends the cell inside this, and reaches nothing outside it.

    Held off by the operating system rather than caught, so that "an
    interrupt between two cells is harmless" is a property of the process
    instead of a list of the places that remembered to guard themselves.
    One landing in the read of the next cell, in the write of the last one's
    answer, or anywhere between the two, is delivered nowhere at all.
    """
    previous = signal.getsignal(signal.SIGINT)
    try:
        # Installed inside the try, not before it: a signal already on its way
        # is raised the instant this returns, and putting it back is what the
        # `finally` below is for. Set outside, that raise would leave the
        # kernel taking signals for everything that came after.
        signal.signal(signal.SIGINT, signal.default_int_handler)
        yield
    finally:
        # Until it takes. Putting a handler back is itself interruptible, and
        # a single attempt cut short leaves the kernel taking signals for
        # everything that comes after — which is how a cell's *answer* ends
        # up interrupted instead of the cell. Each raise here is a signal
        # that had already arrived, aimed at a cell that has now ended; once
        # the change lands no further ones are delivered, so this ends.
        while True:
            try:
                signal.signal(signal.SIGINT, previous)
                break
            except KeyboardInterrupt:
                continue


def _streams(written: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """Consecutive writes to one stream as one message."""
    outputs: list[dict[str, Any]] = []
    for name, text in written:
        if outputs and outputs[-1]["name"] == name:
            outputs[-1]["text"] += text
        else:
            outputs.append({"kind": "stream", "name": name, "text": text})
    return outputs


def _ran(source: str, namespace: dict[str, Any], count: int) -> dict[str, Any]:
    try:
        code, evaluated = _compiled(source)
    except SyntaxError as bad:
        # Nothing ran, so there is no frame of the researcher's to show and
        # no output to report either.
        return {"ok": False, "execution_count": count, "outputs": [_error(bad, None)]}

    written: list[tuple[str, str]] = []
    value: Any = None
    shown: str | None = None
    failed: dict[str, Any] | None = None
    with (
        redirect_stdout(_Recorded("stdout", written)),
        redirect_stderr(_Recorded("stderr", written)),
    ):
        try:
            with _interruptible():
                # The only instructions in this process a signal can reach.
                # Everything below runs with the kernel deaf to them, so that
                # describing what a cell did cannot itself be interrupted —
                # an interrupt landing there would leave the cell with no
                # answer at all rather than with the answer "interrupted".
                if evaluated:
                    value = eval(code, namespace)  # noqa: S307 - the cell is the input
                else:
                    exec(code, namespace)  # noqa: S102 - the cell is the input
            if value is not None:
                # Displayed while the capture is still in place: a `__repr__`
                # that prints belongs in this cell's own output, and on the
                # real stream it would be a line the host tries to read a
                # cell's answer out of.
                shown = _rendered(lambda: repr(value), "a value")
        except BaseException as raised:  # noqa: BLE001 - reported, never fatal
            # The frame that ran the cell is this file's, and a researcher
            # reading a traceback of their own code has no use for it.
            below = raised.__traceback__.tb_next if raised.__traceback__ else None
            failed = _error(raised, below)

    outputs = _streams(written)
    if failed is not None:
        outputs.append(failed)
        return {"ok": False, "execution_count": count, "outputs": outputs}
    if shown is not None:
        outputs.append(
            {
                "kind": "execute_result",
                "execution_count": count,
                "data": {"text/plain": shown},
                "data_ref": {},
            }
        )
    return {"ok": True, "execution_count": count, "outputs": outputs}


def run(source: str, namespace: dict[str, Any], count: int) -> dict[str, Any]:
    """One cell, and an answer for it whatever happens.

    Nothing a cell does leaves this without one. A result that never arrives
    is a kernel the host waits on for as long as it is up, which is a worse
    thing to be on the other end of than a kernel that reported a failure.
    """
    try:
        return _ran(source, namespace, count)
    except BaseException as raised:  # noqa: BLE001 - reported, never fatal
        return {"ok": False, "execution_count": count, "outputs": [_error(raised, None)]}


def main() -> None:
    # The real stream, taken before any cell is given the chance to redirect
    # one: a result written into a cell's own capture is a result the host
    # waits for and never reads.
    answers = sys.stdout
    namespace: dict[str, Any] = {"__name__": "__main__"}
    count = 0
    # Off for everything but a cell, and put back for the length of one. A
    # kernel is a namespace held open, and a signal aimed at a cell that has
    # already finished must not be what closes it.
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    answers.write(json.dumps({"ready": True}) + "\n")
    answers.flush()

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        stripped = line.strip()
        if not stripped:
            continue
        try:
            request = json.loads(stripped)
        except ValueError:
            continue
        count += 1
        answers.write(json.dumps(run(str(request.get("source", "")), namespace, count)) + "\n")
        answers.flush()


if __name__ == "__main__":
    main()
