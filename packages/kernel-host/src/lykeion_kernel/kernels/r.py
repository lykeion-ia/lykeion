"""One R interpreter, held open behind the boundary it was given.

The same launch shape as Python — the stderr tail, the escalation ladder on
stop, the pid start-token guard — over record framing instead of one JSON
object per line. What it produces is the same `KernelMessage` dicts the Python
driver produces, so nothing above a kernel needs a language branch.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
from pathlib import Path
from typing import Any, IO

from ..confinement import confined
from . import KernelIdentity
from .python import ESCALATION_S, KERNEL_MARKER, STDERR_TAIL, start_token

DRIVER = str(Path(__file__).resolve().parent.parent / "driver.R")

# Where R writes its own temporary files. Without this, a kernel inside the
# boundary aborts with `cannot create 'R_TempDir'` and never starts at all:
# the machine's shared temporary directory is outside every workspace rule.
# The daemon does the same for sessions, in scratch.ts.
SCRATCH_DIR = ".lykeion"


def _tmp_dir(workspace: str) -> str:
    return os.path.join(workspace, SCRATCH_DIR, "tmp")


class RKernel:
    """A running R process and the pipe a cell reaches it over."""

    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        self._process = process
        self._start_token = start_token(process.pid)
        self._stderr = [""]
        self._count = 0
        # Whether the driver has said it is inside a cell and has not yet
        # written the terminator. What interrupt() consults, rather than
        # whether a turn has been taken: a turn goes true 10-15ms before the
        # interpreter is inside the cell, and a signal in that gap wedged the
        # kernel permanently — measured, 3/3, first try at 20ms.
        self._in_flight = threading.Event()
        self._drain = threading.Thread(target=self._keep_stderr, daemon=True)
        self._drain.start()

    @property
    def pid(self) -> int:
        return self._process.pid

    @property
    def start_token(self) -> str:
        return self._start_token

    def stderr_tail(self) -> str:
        return self._stderr[0]

    def alive(self) -> bool:
        if self._process.poll() is not None:
            return False
        return start_token(self._process.pid) == self._start_token

    def execute(self, source: str) -> dict[str, Any]:
        stdin = self._process.stdin
        if stdin is None or self._process.stdout is None:
            raise RuntimeError("this kernel has no pipe left to run a cell over")
        self._count += 1
        payload = source.encode("utf-8")
        try:
            stdin.write(f"{len(payload)}\n".encode("utf-8") + payload)
            stdin.flush()
        except (BrokenPipeError, ValueError) as gone:
            raise RuntimeError("this kernel stopped while running a cell") from gone
        return self._collect()

    def interrupt(self) -> None:
        """Ends the cell in flight, and nothing else.

        Sent only between the driver's `run` record and its terminator, and
        only while the start token beside the pid still matches. A kernel with
        no cell in it is not signalled at all: base R exposes no `signal()`
        binding, so an R kernel cannot be deaf to signals between cells the way
        the Python driver is, and this handshake stands in for that.

        The two questions are asked in this order and not the other, which is
        the whole of what keeps the second one honest. `alive()` is not free —
        it asks this platform when the process behind the pid started, and on
        darwin that is a subprocess and some two to five milliseconds of one.
        A cell can finish inside those milliseconds. Asked first, the flag is
        read at the last possible instant before the signal goes; asked last,
        the signal would be sent on the strength of a flag that may have
        fallen while the platform was being consulted — and a signal arriving
        after its cell has ended is the one this driver has to work hardest to
        survive.
        """
        if not self.alive():
            return
        if not self._in_flight.is_set():
            return
        os.kill(self._process.pid, signal.SIGINT)

    def stop(self) -> None:
        process = self._process
        if process.poll() is None:
            self._close(process.stdin)
            try:
                process.wait(timeout=ESCALATION_S)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=ESCALATION_S)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        self._drain.join(timeout=ESCALATION_S)
        for stream in (process.stdin, process.stdout, process.stderr):
            self._close(stream)

    def _collect(self) -> dict[str, Any]:
        """Every record of one cell, up to the terminator that is its status."""
        written: list[tuple[str, str]] = []
        error: dict[str, Any] | None = None
        value: str | None = None
        while True:
            record = self._record()
            if record is None:
                # The interpreter went while the cell was in it, or its stream
                # desynchronised. Either way there is no status coming, and
                # this cell is abandoned where it stands.
                self._abandon()
                tail = self.stderr_tail()
                raise RuntimeError(
                    f"this kernel stopped while running a cell{f': {tail}' if tail else ''}"
                )
            tag, body = record
            if tag == "run":
                # The driver is inside the cell now, and every signal this
                # host sends is sent from here on. Cleared again on the way
                # out below, on both ways out: a flag left standing would put
                # the next interrupt into whatever the kernel does next.
                self._in_flight.set()
                continue
            if tag == "out":
                written.append(("stdout", body))
            elif tag == "err":
                written.append(("stderr", body))
            elif tag == "value":
                value = body
            elif tag == "error":
                name, _, message = body.partition("\n")
                error = {
                    "kind": "error",
                    "ename": name,
                    "evalue": message,
                    "traceback": [message],
                }
            elif tag == "trace":
                if error is not None:
                    error["traceback"] = [error["evalue"], *body.split("\n")]
            elif tag in ("ok", "fail"):
                self._in_flight.clear()
                outputs = _streams(written)
                if error is not None:
                    outputs.append(error)
                elif value is not None:
                    outputs.append(
                        {
                            "kind": "execute_result",
                            "execution_count": self._count,
                            "data": {"text/plain": value},
                            "data_ref": {},
                        }
                    )
                return {
                    "ok": tag == "ok",
                    "execution_count": self._count,
                    "outputs": outputs,
                }

    def _abandon(self) -> None:
        """Ends this process, because its stream can no longer be read.

        The one way out of `_collect` that has read no terminator, and the
        kernel must not survive it. What is left behind otherwise is a live
        interpreter one record out of step with the host: the terminator this
        cell never read is still in the pipe, so the next cell reads it, and
        the one after that reads the next cell's — a session that answers
        every question with the previous question's answer and marks all of
        them `ok`. Measured, before this: `cat('third\\n')` came back empty,
        `2 + 2` printed `third`, `cat('fifth\\n')` answered `[1] 4`. A
        researcher has no way to see that, and a notebook read back afterwards
        has no way to show it.

        So the process is killed rather than asked to stop. There is nothing
        to negotiate — this end cannot say where the next record begins, and
        the escalation ladder in stop() spends its patience on a driver that
        might still answer, which is exactly what this one has proven it
        cannot. What the registry then sees is `crashed` rather than `idle`,
        which is what the absence table promises for a stream that slipped,
        and never `stopped`: nobody asked for this.

        `_in_flight` goes with it. A flag left standing would put the next
        interrupt into a kernel with no cell in it — and, once the platform
        has handed the pid on, into whatever now holds it.
        """
        self._in_flight.clear()
        if self._process.poll() is None:
            self._process.kill()
        try:
            self._process.wait(timeout=ESCALATION_S)
        except subprocess.TimeoutExpired:
            # A process that outlives SIGKILL is one this host cannot end at
            # all, and the caller is owed its error either way. `alive()` will
            # go on saying so for as long as it is true.
            pass

    def _record(self) -> tuple[str, str] | None:
        stream = self._process.stdout
        if stream is None:
            return None
        header = stream.readline()
        if not header:
            return None
        try:
            tag, _, count = header.decode("utf-8").strip().partition(" ")
            length = int(count)
        except ValueError:
            # A record this end cannot read is a stream that desynchronised,
            # and a kernel whose output stream desynchronised is not one to go
            # on trusting.
            return None
        body = _exactly(stream, length)
        if len(body) != length:
            return None
        # "replace" rather than strict, which is what the stderr drain below
        # has always done and what this had no reason to do differently. An R
        # cell can put a byte on this stream that is not UTF-8 without doing
        # anything exotic — `cat(readLines(f))` on a latin-1 CSV, rawToChar
        # over a binary column, any package that writes bytes of its own — and
        # the driver counts BYTES, so the framing is intact and only the
        # rendering is in question. Strict decoding threw that whole record
        # away over its rendering: the cell raised out of execute() with no
        # record produced at all, the terminator was left standing in the pipe,
        # and every cell after it read the one before it while reporting `ok`.
        # Measured, three cells deep: `cat('third\n')` came back empty, `2 + 2`
        # printed `third`, and `cat('fifth\n')` answered `[1] 4`. The Python
        # driver cannot reach this state — it carries text through JSON, which
        # settles the encoding at the far end — so this is where the two
        # languages had quietly stopped agreeing. Mojibake in the one cell that
        # produced it is the whole cost, and it stays in that cell.
        return tag, body.decode("utf-8", "replace")

    def _keep_stderr(self) -> None:
        stream = self._process.stderr
        if stream is None:
            return
        try:
            for line in stream:
                self._stderr[0] = (self._stderr[0] + line.decode("utf-8", "replace"))[-STDERR_TAIL:]
        except (OSError, ValueError):
            return

    @staticmethod
    def _close(stream: Any) -> None:
        if stream is None:
            return
        try:
            stream.close()
        except OSError:
            return


def _exactly(stream: IO[bytes], count: int) -> bytes:
    """Exactly this many bytes, or fewer only at the end of the stream."""
    got = b""
    while len(got) < count:
        chunk = stream.read(count - len(got))
        if not chunk:
            break
        got += chunk
    return got


def _streams(written: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """Consecutive writes to one stream as one message — the same coalescing
    `driver.py` does, so both languages produce one shape."""
    outputs: list[dict[str, Any]] = []
    for name, text in written:
        if outputs and outputs[-1]["name"] == name:
            outputs[-1]["text"] += text
        else:
            outputs.append({"kind": "stream", "name": name, "text": text})
    return outputs


def launch(
    identity: KernelIdentity,
    prefix: list[str],
    interpreter: str,
    cwd: str | None = None,
) -> RKernel:
    """An R kernel process, started behind the prefix the daemon rendered.

    `--vanilla` is load-bearing rather than tidiness: the kernel policy
    declares NO_AGENT_HOME, so ~/.Rprofile and ~/.Renviron are outside the
    boundary. Without it every R kernel would begin by trying to read files it
    is denied and reporting startup noise for a boundary working correctly.
    """
    argv = confined(prefix, [interpreter, "--vanilla", DRIVER])
    env = {**os.environ, KERNEL_MARKER: _marker(identity)}
    if cwd is not None:
        # The workspace is not created here — the daemon's runs.ts guarantees
        # it through ensureTaskDir before any kernel is asked for.
        env["TMPDIR"] = _tmp_dir(cwd)
        os.makedirs(env["TMPDIR"], exist_ok=True)
    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    kernel = RKernel(process)
    if not _greeted(kernel):
        kernel.stop()
        tail = kernel.stderr_tail()
        raise RuntimeError(f"this machine's r kernel did not start{f': {tail}' if tail else ''}")
    return kernel


def _greeted(kernel: RKernel) -> bool:
    record = kernel._record()  # noqa: SLF001 - the greeting is one record of its own stream
    return record is not None and record[0] == "ready"


def _marker(identity: KernelIdentity) -> str:
    return "/".join([identity.session_id, identity.task_id, identity.name, identity.language])
