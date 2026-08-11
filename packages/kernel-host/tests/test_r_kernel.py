"""RKernel: an R process held open behind the boundary it was given."""

from __future__ import annotations

import json
import os
import shutil
import signal
import time
from pathlib import Path

import pytest

from lykeion_kernel.kernels import KernelIdentity
from lykeion_kernel.kernels.r import RKernel, launch

pytestmark = pytest.mark.integration

RSCRIPT = shutil.which("Rscript")

IDENTITY = KernelIdentity(session_id="ses_1", task_id="task_1", name="main", language="r")

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "ui"
    / "src"
    / "components"
    / "tasks"
    / "__fixtures__"
    / "r-cell.json"
)


@pytest.fixture
def kernel(tmp_path):
    if RSCRIPT is None:
        pytest.skip("this machine has no Rscript, so it holds no R kernels")
    started = launch(IDENTITY, ["/usr/bin/env"], RSCRIPT, str(tmp_path))
    try:
        yield started
    finally:
        started.stop()


def test_a_cell_comes_back_in_the_shape_the_python_driver_produces(kernel):
    result = kernel.execute("cat('hi\\n')\n1 + 1")
    assert result["ok"] is True
    assert result["execution_count"] == 1
    kinds = [output["kind"] for output in result["outputs"]]
    assert kinds == ["stream", "execute_result"]
    assert result["outputs"][0] == {"kind": "stream", "name": "stdout", "text": "hi\n"}
    assert result["outputs"][1]["data"]["text/plain"].strip().endswith("2")
    assert result["outputs"][1]["execution_count"] == 1
    assert result["outputs"][1]["data_ref"] == {}


def test_a_raising_cell_reports_an_error_output_and_the_kernel_runs_the_next(kernel):
    result = kernel.execute("f <- function() stop('deliberate')\nf()")
    assert result["ok"] is False
    error = result["outputs"][-1]
    assert error["kind"] == "error"
    assert error["ename"] == "simpleError"
    assert "deliberate" in error["evalue"]
    assert any("f()" in line for line in error["traceback"])
    assert not any("run_cell" in line for line in error["traceback"])
    assert kernel.execute("1 + 1")["ok"] is True


def test_a_custom_conditions_class_reaches_the_kernel_as_its_own_ename(kernel):
    # A cell's own condition classes are the researcher's vocabulary, not
    # this kernel's. `stop('deliberate')` alone cannot tell an `ename` that
    # is merely echoed apart from one that was actually read off the
    # condition's class, since every simpleError shares that name; only a
    # condition of some other class can.
    result = kernel.execute(
        "stop(structure(class = c('myError', 'error', 'condition'), "
        "list(message = 'custom', call = NULL)))"
    )
    assert result["ok"] is False
    error = result["outputs"][-1]
    assert error["ename"] == "myError"
    assert error["evalue"] == "custom"


def test_a_syntax_error_reports_its_real_class_and_the_whole_message(kernel):
    # Before Task 6, driver.R's parse-failure branch reported its message
    # bare. r.py's `error` reader has since read `class\nmessage` off the
    # wire for every error record — a parse failure emitted without that
    # prefix has its own diagnosis ("unexpected '{'") consumed as `ename`,
    # dropped from what the researcher is shown, leaving only the caret
    # diagram underneath it. Checked by equality, not membership, so a
    # regression that drops or reorders a line cannot hide behind `in`.
    result = kernel.execute("if (TRUE {")
    assert result["ok"] is False
    error = result["outputs"][-1]
    assert error["kind"] == "error"
    assert error["ename"] == "simpleError"
    assert error["evalue"] == "<text>:1:10: unexpected '{'\n1: if (TRUE {\n             ^"
    assert kernel.execute("1 + 1")["ok"] is True


def test_the_counter_advances_once_per_cell(kernel):
    assert kernel.execute("1")["execution_count"] == 1
    assert kernel.execute("2")["execution_count"] == 2


def test_a_cell_interrupted_mid_run_ends_as_a_failed_cell(kernel):
    import threading

    started = threading.Event()

    def interrupting():
        started.wait(timeout=5)
        time.sleep(0.2)
        kernel.interrupt()

    firing = threading.Thread(target=interrupting, daemon=True)
    firing.start()
    started.set()
    result = kernel.execute("Sys.sleep(10)")
    firing.join(timeout=5)

    # A failed cell, never a silent one. The wedge this replaces left the
    # host blocked forever with the turn stuck running and listRunningKernels
    # reporting the kernel alive to the whole lab.
    assert result["ok"] is False
    assert result["outputs"][-1]["kind"] == "error"
    # And the kernel runs the next one.
    assert kernel.execute("1 + 1")["ok"] is True


# A matrix whose printing this machine takes about two and a half seconds
# over, so a signal fired half a second in lands squarely in the rendering
# and not in anything either side of it.
SLOW_TO_PRINT = "big <- matrix(stats::rnorm(600000), ncol = 3)"


def test_a_cell_interrupted_while_rendering_its_value_still_answers(kernel):
    # Where a researcher actually reaches for Interrupt. The cell has already
    # finished evaluating by the time this signal arrives — `big` is a symbol
    # lookup — and every second of what remains is the kernel rendering the
    # answer, which is exactly the part a handler around the evaluation alone
    # does not cover. Measured on this machine before the handler covered it:
    # ten runs out of ten came back with no terminator at all, the kernel dead
    # and the session's namespace with it.
    kernel.execute(SLOW_TO_PRINT)

    import threading

    threading.Timer(0.5, kernel.interrupt).start()
    result = kernel.execute("big")

    assert result["ok"] is False
    # By name, because only an interrupt produces this one: a cell that merely
    # finished, or failed some other way, could not.
    assert result["outputs"][-1]["ename"] == "lykeionInterrupt"
    assert kernel.alive() is True
    assert kernel.execute("1 + 1")["ok"] is True


def test_a_cell_interrupted_while_autoprinting_still_answers(kernel):
    # The same window one statement earlier: a visible value that is not the
    # cell's last autoprints as R's own REPL does, and that printing sits
    # inside the loop but outside the evaluation it wraps. Six runs out of six
    # ended the kernel before this was covered.
    kernel.execute(SLOW_TO_PRINT)

    import threading

    threading.Timer(0.5, kernel.interrupt).start()
    result = kernel.execute("big\n1 + 1")

    assert result["ok"] is False
    assert result["outputs"][-1]["ename"] == "lykeionInterrupt"
    assert kernel.execute("1 + 1")["ok"] is True


def test_what_an_interrupted_cell_printed_before_the_signal_still_comes_back(kernel):
    # What the capture is put back FOR. A researcher interrupting a long loop
    # is usually interrupting it because of what it has been printing, and
    # that output is sitting in this cell's own capture when the signal
    # arrives — held there, unsent, by a sink that the interrupt unwinds the
    # frame straight past. It comes back because run_cell asks on.exit to put
    # the capture back whatever ends it, rather than only on the way out of a
    # cell that ended of its own accord.
    import threading

    threading.Timer(0.4, kernel.interrupt).start()
    result = kernel.execute("cat('printed before\\n')\nSys.sleep(5)")

    assert result["ok"] is False
    printed = [output for output in result["outputs"] if output["kind"] == "stream"]
    assert printed, "the cell's own output never came back"
    assert "printed before" in printed[0]["text"]
    assert result["outputs"][-1]["ename"] == "lykeionInterrupt"


def test_a_signal_owed_to_a_finished_cell_never_leaves_the_next_unanswered(kernel):
    # The host's own byte shape, which is one write carrying the header and
    # the payload together — not the two the driver's own test has to
    # construct to reach the read's guard. A signal sent straight to the pid,
    # around the gate, stands for one the gate let through a moment too late.
    #
    # R holds such a signal pending rather than raising it — a blocked read
    # notices nothing — and raises it at the next check it makes, which is
    # somewhere inside the NEXT cell. Whether it surfaces at all is not
    # something this end decides, so what is asserted is the part that must
    # hold either way: the cell is answered, and the kernel is still there.
    kernel.execute("1 + 1")
    os.kill(kernel.pid, signal.SIGINT)
    time.sleep(0.05)

    result = kernel.execute("cat('after\\n')\n1 + 1")
    assert result["ok"] is True or result["outputs"][-1]["ename"] == "lykeionInterrupt"
    assert kernel.alive() is True
    assert kernel.execute("1 + 1")["ok"] is True


def test_a_signal_is_sent_only_while_a_cell_is_in_it(kernel, monkeypatch):
    # The gate itself, asserted on what it decides rather than on what the
    # kernel does afterwards. That distinction earns its keep now: the driver
    # has been made to absorb a stray signal between cells rather than die of
    # one, so every end-to-end reading of this property passes whether the
    # gate is there or not, and the gate would sit uncovered behind a kernel
    # that no longer needs it. It is still wanted — two defences, not one, and
    # a signal not sent cannot be absorbed wrongly — so it is read here at the
    # point of decision, in both directions.
    sent: list[int] = []
    monkeypatch.setattr(os, "kill", lambda pid, number: sent.append(number))

    kernel.execute("1 + 1")
    kernel.interrupt()
    assert sent == [], "a kernel between cells was signalled"

    import threading

    threading.Timer(0.2, kernel.interrupt).start()
    # Nothing is really signalled — os.kill is the recorder above — so this
    # cell runs its full length and the reading is of the decision alone.
    assert kernel.execute("Sys.sleep(0.6)")["ok"] is True
    assert sent == [signal.SIGINT], "a kernel with a cell in it was not signalled"


def test_an_interrupt_with_no_cell_in_flight_signals_nothing(kernel):
    # A cell first, so this is the state a kernel is actually in between two
    # of them — the flag raised once and lowered again — rather than the state
    # it is in before it has ever run anything. A host that raises the flag
    # and never lowers it passes the second reading and fails this one.
    kernel.execute("1 + 1")
    kernel.interrupt()
    kernel.interrupt()
    # Nothing was owed and nothing was sent, so the kernel is untouched.
    assert kernel.alive() is True
    assert kernel.execute("1 + 1")["ok"] is True


@pytest.mark.parametrize("attempt", range(40))
def test_an_interrupt_landing_between_two_cells_is_harmless(kernel, attempt):
    # Run in bulk rather than once: the failure this guards against is a race,
    # and a race asserted once is a race not asserted.
    kernel.execute("1 + 1")
    kernel.interrupt()
    # A cell that would NOTICE, which `1 + 1` does not: R holds a signal
    # pending until it next checks, and evaluating an arithmetic constant
    # never checks at all — so a gate that had wrongly sent one would leave it
    # sitting in the kernel, and forty runs of this would pass with a live
    # signal in every one of them. Sys.sleep checks immediately, so it comes
    # back interrupted the instant anything was sent.
    assert kernel.execute("Sys.sleep(0.05)")["ok"] is True


def test_the_in_flight_flag_is_what_makes_the_interrupt_safe(kernel, monkeypatch):
    # A gate that passes both mutations is not a gate. This is the always-off
    # half: held shut, an interrupt fired inside a cell reaches nothing at all
    # and the cell runs its full length. The always-on half is next door —
    # held open, the two interrupts that
    # test_an_interrupt_with_no_cell_in_flight_signals_nothing fires between
    # cells reach a driver with nothing to interrupt and end it outright,
    # `Execution halted`.
    kernel.execute("1 + 1")
    monkeypatch.setattr(kernel._in_flight, "is_set", lambda: False)
    began = time.monotonic()

    import threading

    threading.Timer(0.2, kernel.interrupt).start()
    result = kernel.execute("Sys.sleep(2)")
    # Never signalled, so the cell ran its full length.
    assert result["ok"] is True
    assert time.monotonic() - began >= 1.5


def test_a_kernel_that_goes_mid_cell_leaves_no_signal_owed(kernel):
    # The other way out of a cell, and the one with no terminator in it. A
    # `run` that is never answered leaves the flag standing, and the next
    # interrupt then goes to whatever the kernel does next — or, once the pid
    # has been handed on, to whatever now holds it. Asserted through the flag
    # itself because the second half of that sentence has no safe rehearsal.
    import threading

    threading.Timer(0.2, kernel._process.kill).start()
    with pytest.raises(RuntimeError, match="stopped while running a cell"):
        kernel.execute("Sys.sleep(10)")
    assert kernel._in_flight.is_set() is False


def test_a_byte_that_is_not_utf8_stays_in_the_cell_that_produced_it(kernel):
    # Ordinary R, not an exotic one: a latin-1 file read back with readLines
    # and printed is the commonest way a researcher's own data puts a byte on
    # this stream that UTF-8 has no reading for. `cat(readLines(f))` on a CSV
    # exported by a Spanish till system is the case this was found from, and
    # the byte below is that file's `é`.
    #
    # The framing survives it by construction — the driver counts BYTES, and
    # every byte is accounted for whatever it means — so the only question
    # this ever raised was how to RENDER the record, and the answer must not
    # be to throw the record away. Decoded strictly it was: the cell raised
    # out of execute() with no cell record produced at all, the terminator it
    # never read stayed in the pipe, and every cell after it silently answered
    # with the one before's. That is why the three cells below are here rather
    # than one — a mojibake assertion alone passes on a stream one record out
    # of step, since the first cell after would still look right.
    result = kernel.execute("cat('caf', rawToChar(as.raw(0xe9)), '\\n', sep='')")
    assert result["ok"] is True
    assert result["outputs"] == [{"kind": "stream", "name": "stdout", "text": "caf�\n"}]

    # Correctly framed afterwards: each of these is answered with its own
    # answer. Before the fix, measured: the first came back empty, the second
    # printed `third`, the third answered `[1] 4` — all three marked ok.
    assert kernel.execute("cat('third\\n')")["outputs"] == [
        {"kind": "stream", "name": "stdout", "text": "third\n"}
    ]
    squared = kernel.execute("2 + 2")
    assert squared["outputs"][-1]["data"]["text/plain"].strip().endswith("4")
    assert kernel.execute("cat('fifth\\n')")["outputs"] == [
        {"kind": "stream", "name": "stdout", "text": "fifth\n"}
    ]


def test_a_kernel_whose_stream_slipped_is_left_dead_rather_than_answering(kernel):
    # The other half of the same finding, and the one the encoding fix does
    # not reach. A record this end cannot read is a stream that desynchronised
    # however it got that way, and the cell it happened in is abandoned with
    # its terminator still in the pipe. What must not survive that is the
    # KERNEL: a live interpreter one record out of step answers every
    # question with the previous question's answer and marks them all ok,
    # which is the one failure a researcher has no way to see and a notebook
    # read back afterwards no way to show.
    #
    # Reached the way a cell can actually reach it, without patching anything:
    # the framing channel IS stdout, so a cell that opens it for itself and
    # writes writes into the record stream. The driver sinks the researcher's
    # printing, not their connections, and this is the shape of every genuine
    # slip — a signal that cost a byte reaches the same place.
    #
    # `alive()` is what the registry's state is read from, so False here is
    # `crashed` in kernel.list rather than the `idle` it reported before, and
    # never `stopped`: nobody asked for this. The mapping itself is held by
    # test_registry.py's own crashed-rather-than-stopped test.
    with pytest.raises(RuntimeError, match="stopped while running a cell"):
        kernel.execute(
            "con <- file('/dev/stdout', 'wb')\n"
            "writeBin(charToRaw('not a record at all\\n'), con)\n"
            "flush(con)"
        )
    assert kernel.alive() is False
    # And no signal is left owed against a pid this host no longer holds.
    assert kernel._in_flight.is_set() is False


def test_an_empty_cell_still_comes_back_answered(kernel):
    # The read that skips an interrupt must skip nothing else. An empty cell
    # is a cell the host has already counted and is already blocked waiting
    # for — a driver that quietly went back to reading would leave it waiting
    # forever, which is the wedge this whole handshake exists to prevent, in
    # the one place it would be easiest to reintroduce.
    result = kernel.execute("")
    assert result["ok"] is True
    assert result["outputs"] == []
    assert kernel.execute("1 + 1")["ok"] is True


def test_a_kernel_starts_with_none_of_the_machines_own_r_startup_files(tmp_path, monkeypatch):
    # `--vanilla` on the launcher, asserted rather than declared. The kernel
    # policy grants no home, so ~/.Rprofile and ~/.Renviron are outside every
    # boundary this machine renders — a kernel that tried to read them would
    # begin every session by being refused, and report a working boundary as
    # startup noise. Worse than the noise: a profile that DID get through
    # would be a researcher's own code running before the driver does, in the
    # namespace the agent is about to be handed.
    #
    # Made a real mutation rather than a reading of the argv, and made without
    # going near the researcher's home: R looks these two up through
    # R_PROFILE_USER and R_ENVIRON_USER before it looks in a home directory,
    # so a profile planted in tmp_path and named through them is the same test
    # with nothing of theirs touched. Measured both ways on this machine's R
    # 4.6.1 — without `--vanilla` this profile runs and this variable is set,
    # with it neither happens — so the assertions below fail if the flag is
    # dropped rather than merely going on being true.
    if RSCRIPT is None:
        pytest.skip("this machine has no Rscript, so it holds no R kernels")
    profile = tmp_path / "Rprofile"
    profile.write_text("PLANTED <- 'the profile ran'\n")
    environ = tmp_path / "Renviron"
    environ.write_text("LYKEION_PLANTED=the environ ran\n")
    monkeypatch.setenv("R_PROFILE_USER", str(profile))
    monkeypatch.setenv("R_ENVIRON_USER", str(environ))
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    started = launch(IDENTITY, ["/usr/bin/env"], RSCRIPT, str(workspace))
    try:
        planted = started.execute("exists('PLANTED')")
        assert planted["outputs"][-1]["data"]["text/plain"].strip() == "[1] FALSE"
        carried = started.execute("Sys.getenv('LYKEION_PLANTED')")
        assert carried["outputs"][-1]["data"]["text/plain"].strip() == '[1] ""'
    finally:
        started.stop()


def test_a_kernel_that_will_not_start_says_what_the_machine_said(tmp_path):
    if RSCRIPT is None:
        pytest.skip("this machine has no Rscript, so it holds no R kernels")
    with pytest.raises(RuntimeError, match="this machine's r kernel did not start"):
        launch(IDENTITY, ["/usr/bin/env"], "/nonexistent/Rscript", str(tmp_path))


def test_a_dead_kernel_raises_the_way_a_dead_python_kernel_does(kernel):
    kernel.stop()
    with pytest.raises(RuntimeError, match="this kernel"):
        kernel.execute("1")


def test_the_recorded_cell_the_ui_renders_is_one_this_machine_actually_produced(kernel):
    # The UI's R chip has been proven only by hand-written fixtures since
    # phase 1. This ties the fixture it renders to real output: a driver whose
    # shape drifts fails here, loudly and by name, rather than leaving the
    # panel green against something no machine produces.
    result = kernel.execute("cat('hi\\n')\n1 + 1")
    recorded = json.loads(FIXTURE.read_text())
    assert recorded["language"] == "r"
    assert recorded["environment"] == "r"
    assert [output["kind"] for output in recorded["outputs"]] == [
        output["kind"] for output in result["outputs"]
    ]
    assert recorded["outputs"][0] == result["outputs"][0]
