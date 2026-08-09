"""One Python interpreter, held open behind the boundary it was given."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from ..confinement import confined
from . import KernelIdentity

DRIVER = str(Path(__file__).resolve().parent.parent / "driver.py")

# How much of what a kernel wrote to its own stderr is kept. Enough to say
# why one would not start — a boundary refusing a read, an interpreter that
# is not there — without holding every line a long-lived process ever wrote.
STDERR_TAIL = 8192

# How long a kernel asked to stop is given before it is signalled, and again
# before it is killed. A process that has not gone after this long is not
# going, and a host that waited on it would hold the whole machine open.
ESCALATION_S = 1.0

# What a process on this machine says about which kernel it is. The host is
# the only thing that knows, and a researcher looking at their own machine
# has otherwise nothing but an interpreter with a driver's path after it.
KERNEL_MARKER = "LYKEION_KERNEL"


def start_token(pid: int) -> str:
    """When the process holding `pid` started, as this platform states it.

    A pid is reused. A status that claimed a kernel was alive on the pid
    alone would, after that reuse, be claiming something about whatever now
    holds it — so what the platform said at spawn is compared against what
    it says now, and a kernel whose token has changed is a kernel that is
    gone.

    Empty when the platform will not say, which is what a pid nothing holds
    answers with.
    """
    try:
        if sys.platform == "darwin":
            asked = subprocess.run(
                ["/bin/ps", "-o", "lstart=", "-p", str(pid)],
                capture_output=True,
                text=True,
                check=False,
            )
            return asked.stdout.strip()
        stat = Path(f"/proc/{pid}/stat").read_text()
        # The command name sits in parentheses and may hold both spaces and
        # parentheses of its own, so the fields are counted from the last
        # one rather than from the start of the line: what is wanted is the
        # twenty-second, which is the third one after the name.
        return stat[stat.rindex(")") + 1 :].split()[19]
    except (OSError, ValueError, IndexError):
        return ""


class PythonKernel:
    """A running interpreter and the pipe a cell reaches it over."""

    def __init__(self, process: subprocess.Popen[str]) -> None:
        self._process = process
        self._start_token = start_token(process.pid)
        # One slot rather than a growing list: what is wanted is the tail,
        # and a kernel left running for a week must not accumulate a week of
        # it. Written by the drain alone and read by anything.
        self._stderr = [""]
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
        """One cell, run to completion in the namespace this process holds."""
        stdin = self._process.stdin
        stdout = self._process.stdout
        if stdin is None or stdout is None:
            raise RuntimeError("this kernel has no pipe left to run a cell over")
        stdin.write(json.dumps({"source": source}) + "\n")
        stdin.flush()
        answer = stdout.readline()
        if not answer.strip():
            # The interpreter went while the cell was in it. Said rather than
            # answered with an empty result: a cell that produced nothing and
            # a cell whose kernel died are not the same outcome.
            self._process.wait(timeout=ESCALATION_S)
            tail = self.stderr_tail()
            raise RuntimeError(
                f"this kernel stopped while running a cell{f': {tail}' if tail else ''}"
            )
        return json.loads(answer)

    def interrupt(self) -> None:
        """Ends the cell in flight, and nothing else.

        Sent to the pid this kernel recorded and only while the token beside
        it still matches, so an interrupt arriving after a kernel has gone
        reaches nothing rather than whatever now holds that pid. A kernel
        with no cell in it is deaf to this by its own arrangement.
        """
        if not self.alive():
            return
        os.kill(self._process.pid, signal.SIGINT)

    def stop(self) -> None:
        """Ends the process and leaves nothing of it behind.

        Its own stdin is closed first, which is what a driver reads an end
        of the day from; a kernel still inside a cell will not see that, so
        it is signalled, and then killed.
        """
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
        # The stream ends when the process does, so this returns rather than
        # waiting out the whole timeout on an ordinary stop.
        self._drain.join(timeout=ESCALATION_S)
        # After the process has ended, and never before it: closing a stream
        # takes the lock whatever is blocked reading that stream holds, so a
        # kernel closed while a cell is still waiting on its answer would
        # wait on a read that only the end of that process finishes.
        for stream in (process.stdin, process.stdout, process.stderr):
            self._close(stream)

    def _keep_stderr(self) -> None:
        stream = self._process.stderr
        if stream is None:
            return
        try:
            for line in stream:
                self._stderr[0] = (self._stderr[0] + line)[-STDERR_TAIL:]
        except (OSError, ValueError):
            # The stream was closed underneath this while it was blocked on
            # it, which is a kernel that has already ended.
            return

    @staticmethod
    def _close(stream: Any) -> None:
        if stream is None:
            return
        try:
            stream.close()
        except OSError:
            # A pipe whose other end has already gone. There is nothing left
            # to close it for, and a stop that raised here would abandon the
            # streams after it.
            return


def launch(
    identity: KernelIdentity,
    prefix: list[str],
    interpreter: str = sys.executable,
    cwd: str | None = None,
) -> PythonKernel:
    """A kernel process, started behind the prefix the daemon rendered.

    The prefix arrives already assembled and this concatenates onto it. A
    kernel that was given none is not started — there is no argument list
    reachable from here that would put an interpreter outside a boundary.
    """
    argv = confined(prefix, [interpreter, "-u", DRIVER])
    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=cwd,
        env={**os.environ, KERNEL_MARKER: _marker(identity)},
    )
    kernel = PythonKernel(process)
    if not _greeted(process):
        # Stopped before its stderr is read, so what is quoted is everything
        # the machine had to say rather than however much of it had arrived.
        kernel.stop()
        tail = kernel.stderr_tail()
        raise RuntimeError(
            f"this machine's python kernel did not start{f': {tail}' if tail else ''}"
        )
    return kernel


def _greeted(process: subprocess.Popen[str]) -> bool:
    """Whether the process on the other end is a driver holding a namespace.

    A kernel that failed inside its boundary closes its stdout without
    writing anything, and one that started something else entirely writes
    something this cannot read. Neither is a kernel.
    """
    if process.stdout is None:
        return False
    line = process.stdout.readline()
    try:
        greeting = json.loads(line)
    except ValueError:
        return False
    return isinstance(greeting, dict) and greeting.get("ready") is True


def _marker(identity: KernelIdentity) -> str:
    return "/".join([identity.session_id, identity.task_id, identity.name, identity.language])
