"""Whether a host still answers while one of its kernels is busy.

Every test here drives `serve()` over real pipes on a thread of its own,
because the property is about the loop: a request answered while another is
in flight cannot be observed by calling a handler directly.
"""

import itertools
import json
import sys
from pathlib import Path

import pytest

IDENTITY = {"session_id": "sess_1", "task_id": "tk_1", "name": "main", "language": "python"}
ORIGIN = {"surface": "repl", "by": "mem_1"}

# How many cells are sent at once without waiting for any of them. Enough
# that which thread reaches a kernel first is the platform's to decide rather
# than a consequence of how few there were.
PIPELINED = 30


@pytest.fixture
def eager_switching():
    """This platform asked to change between threads as often as it will.

    Which order threads run in is the platform's choice, and it is free to
    make it differently on another machine, under load, or on a build with no
    global lock to hand between them at all. A suite that only ever asked at
    the laziest setting would be asserting that this machine happens to run
    threads in the order they were started.
    """
    was = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        yield
    finally:
        sys.setswitchinterval(was)


def held(marker: Path) -> str:
    """A cell that says it has begun and then does not end on its own.

    Everything these tests are about happens while one of these is running,
    and it says so by touching a file rather than by being waited out: a
    sleep long enough to be sure is a suite nobody runs.
    """
    return f"open({str(marker)!r}, 'w').close()\nimport time; time.sleep(30)"


def confined(spoken, workspace: Path) -> None:
    """The boundary this session's kernels are started inside, said over the
    wire and waited for.

    Waited for rather than sent ahead of the cells that need it: a host reads
    the next message while this one is still being answered, so a cell sent
    before the answer arrived could reach a session that has not been told
    where it may run yet.
    """
    spoken.send(
        {
            "id": 0,
            "method": "kernel.configure_session",
            "params": {
                "session_id": IDENTITY["session_id"],
                "task_id": IDENTITY["task_id"],
                "workspace": str(workspace),
                "environments": [
                    {
                        "language": "python",
                        "name": "python",
                        "interpreter": sys.executable,
                        "prefix": ["/usr/bin/env"],
                        "default": True,
                    }
                ],
            },
        }
    )
    spoken.until(lambda: spoken.reply(0), "the session confined")
    # What follows is the test's own, and this is not what any of it is about.
    spoken.lines.clear()


def test_a_second_request_is_answered_while_a_cell_is_still_running(spoken, tmp_path):
    confined(spoken, tmp_path)
    started = tmp_path / "started"
    spoken.send({"id": 1, "method": "kernel.execute", "params": {
        **IDENTITY, "source": held(started), "origin": ORIGIN}})
    spoken.until(started.exists, "the cell to start")

    spoken.send({"id": 2, "method": "host.hello", "params": {}})
    answered = spoken.until(lambda: spoken.reply(2), "the second request answered")

    assert answered["result"]["protocol"] == 4
    # Answered while the first is still in flight, rather than after it.
    assert spoken.reply(1) is None


def test_a_running_cell_can_be_interrupted_over_the_wire(spoken, tmp_path):
    confined(spoken, tmp_path)
    started = tmp_path / "started"
    spoken.send({"id": 1, "method": "kernel.execute", "params": {
        **IDENTITY, "source": held(started), "origin": ORIGIN}})
    spoken.until(started.exists, "the cell to start")

    spoken.send({"id": 2, "method": "kernel.list", "params": {}})
    listed = spoken.until(lambda: spoken.reply(2), "the kernel list")
    kernel_id = listed["result"]["kernels"][0]["id"]

    spoken.send({"id": 3, "method": "kernel.interrupt", "params": {"kernel_id": kernel_id}})
    cell = spoken.until(lambda: spoken.reply(1), "the interrupted cell to come back")

    assert cell["result"]["ok"] is False
    assert "KeyboardInterrupt" in json.dumps(cell["result"]["outputs"])

    # The cell, and not the kernel behind it: an interrupt that took the
    # namespace with it would be a restart nobody asked for.
    spoken.send({"id": 4, "method": "kernel.execute", "params": {
        **IDENTITY, "source": "print('still here')", "origin": ORIGIN}})
    after = spoken.until(lambda: spoken.reply(4), "the kernel to answer after the interrupt")
    assert after["result"]["ok"] is True


def test_what_is_waiting_behind_a_cell_is_visible_while_it_waits(spoken, tmp_path):
    confined(spoken, tmp_path)
    started = tmp_path / "started"
    spoken.send({"id": 1, "method": "kernel.execute", "params": {
        **IDENTITY, "source": held(started), "origin": ORIGIN}})
    spoken.until(started.exists, "the first cell to start")
    spoken.send({"id": 2, "method": "kernel.execute", "params": {
        **IDENTITY, "source": "1", "origin": ORIGIN}})

    # Asked again under a new id each time, because the cell behind the one
    # running has to have reached the queue before it can be counted in it.
    asked = itertools.count(3)

    def depth_seen():
        spoken.send({"id": next(asked), "method": "kernel.list", "params": {}})
        return next(
            (
                line
                for line in spoken.lines
                if line.get("result", {}).get("kernels")
                and line["result"]["kernels"][0]["queueDepth"] >= 1
            ),
            None,
        )

    listed = spoken.until(depth_seen, "a queue depth of at least one")

    assert listed["result"]["kernels"][0]["state"] == "running"


def test_cells_of_one_kernel_run_in_the_order_they_arrived(eager_switching, spoken, tmp_path):
    confined(spoken, tmp_path)
    # Sent one after another with none of them waited for, which is what a
    # notebook run end to end looks like on this stream.
    spoken.send({"id": 1, "method": "kernel.execute", "params": {
        **IDENTITY, "source": "order = []", "origin": ORIGIN}})
    for n in range(2, PIPELINED + 1):
        spoken.send({"id": n, "method": "kernel.execute", "params": {
            **IDENTITY, "source": f"order.append({n})", "origin": ORIGIN}})
    sent = range(1, PIPELINED + 1)
    spoken.until(lambda: all(spoken.reply(n) for n in sent), "every cell to come back")

    spoken.send({"id": PIPELINED + 1, "method": "kernel.execute", "params": {
        **IDENTITY, "source": "order", "origin": ORIGIN}})
    read_back = spoken.until(lambda: spoken.reply(PIPELINED + 1), "the namespace read back")

    # Read out of the namespace the cells shared, because that is where the
    # order they ran in survives. A count handed out in the same wrong order
    # as the cells would agree with itself about it.
    assert read_back["result"]["outputs"][0]["data"]["text/plain"] == str(
        list(range(2, PIPELINED + 1))
    )
    assert [spoken.reply(n)["result"]["executionCount"] for n in sent] == list(sent)


def test_a_cell_this_host_refuses_leaves_nothing_behind_it(spoken, tmp_path):
    confined(spoken, tmp_path)
    # Named exactly like a cell that would run, and missing only what makes a
    # message one at all.
    spoken.send({"id": 1, "method": "kernel.execute", "params": {
        **IDENTITY, "source": 7, "origin": ORIGIN}})
    spoken.send({"id": 2, "method": "kernel.execute", "params": {
        **IDENTITY, "source": "print('behind it')", "origin": ORIGIN}})
    spoken.send({"id": 3, "method": "kernel.execute", "params": {
        **IDENTITY, "name": "never", "source": 7, "origin": ORIGIN}})

    refused = spoken.until(lambda: spoken.reply(1), "the cell refused")
    assert "a cell has a source" in refused["error"]["message"]

    # Nothing waits behind a cell that is not going to run.
    ran = spoken.until(lambda: spoken.reply(2), "the cell behind it")
    assert ran["result"]["ok"] is True
    spoken.until(lambda: spoken.reply(3), "the cell for a kernel of its own refused")

    spoken.send({"id": 4, "method": "kernel.list", "params": {}})
    listed = spoken.until(lambda: spoken.reply(4), "the kernels this host holds")

    # And no kernel is minted for it: a machine holds kernels for the work
    # that happened rather than for what was asked for and refused.
    assert [kernel["name"] for kernel in listed["result"]["kernels"]] == ["main"]


def test_every_line_the_host_writes_is_a_whole_message(spoken, tmp_path):
    confined(spoken, tmp_path)
    # Four kernels of one session, each answering with more than the stream
    # between this host and its daemon will take in one piece, so the writes
    # that carry them really do arrive interleaved unless something stops it.
    # The thread reading them parses every line on its own, which is what
    # makes one message written inside another a failure here.
    for n in range(1, 21):
        spoken.send({"id": n, "method": "kernel.execute", "params": {
            **IDENTITY, "name": f"k{n % 4}", "source": f"print('x' * 70_000); {n}",
            "origin": ORIGIN}})
    spoken.until(
        lambda: len([line for line in spoken.lines if "id" in line]) == 20, "all twenty replies"
    )

    assert sorted(line["id"] for line in spoken.lines if "id" in line) == list(range(1, 21))
    assert len([line for line in spoken.lines if line.get("method") == "cell"]) == 20
