"""The R driver alone, driven over a pipe the way its kernel drives it.

Adversarial rather than confirmatory: every property asserted here is one the
obvious implementation gets wrong.
"""

from __future__ import annotations

import os
import queue
import selectors
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

import pytest

DRIVER = str(Path(__file__).resolve().parents[1] / "src" / "lykeion_kernel" / "driver.R")

pytestmark = pytest.mark.integration

RSCRIPT = shutil.which("Rscript")


@pytest.fixture
def driver():
    if RSCRIPT is None:
        pytest.skip("this machine has no Rscript, so it holds no R kernels")
    process = subprocess.Popen(
        [RSCRIPT, "--vanilla", DRIVER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert _record(process) == ("ready", b"")
        yield process
    finally:
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def _exactly(stream, count: int) -> bytes:
    got = b""
    while len(got) < count:
        chunk = stream.read(count - len(got))
        if not chunk:
            break
        got += chunk
    return got


def _record(process) -> tuple[str, bytes]:
    header = process.stdout.readline()
    assert header, "the driver ended without a record"
    tag, _, count = header.decode("utf-8").strip().partition(" ")
    return tag, _exactly(process.stdout, int(count))


def _cell(process, source: str) -> list[tuple[str, bytes]]:
    payload = source.encode("utf-8")
    process.stdin.write(f"{len(payload)}\n".encode("utf-8") + payload)
    process.stdin.flush()
    records: list[tuple[str, bytes]] = []
    while True:
        tag, body = _record(process)
        records.append((tag, body))
        if tag in ("ok", "fail"):
            return records


def test_a_cell_holding_a_newline_a_quote_and_multibyte_text_round_trips(driver):
    # A real embedded newline, not an escaped one: the framing counts bytes,
    # and a reader that stopped at a newline would cut this cell in half.
    records = _cell(driver, 'x <- "a\nb \'q\' — Ω"\ncat(x)')
    assert records[-1][0] == "ok"
    out = b"".join(body for tag, body in records if tag == "out").decode("utf-8")
    assert out == "a\nb 'q' — Ω"


def test_one_expression_reports_a_value_and_statements_report_none(driver):
    records = _cell(driver, "1 + 1")
    assert [tag for tag, _ in records if tag == "value"] == ["value"]
    value = next(body for tag, body in records if tag == "value").decode("utf-8")
    assert "2" in value

    records = _cell(driver, "y <- 41 + 1")
    assert [tag for tag, _ in records if tag == "value"] == []
    assert records[-1][0] == "ok"


def test_a_name_bound_by_one_cell_is_still_bound_in_the_next(driver):
    _cell(driver, "kept <- 7")
    value = next(body for tag, body in _cell(driver, "kept") if tag == "value")
    assert "7" in value.decode("utf-8")


def test_a_cell_binding_the_drivers_own_names_runs_and_the_kernel_survives(driver):
    # The driver's bindings live in a closure, not globalenv(). A cell binding
    # `captured` or `emit` must not replace the machinery evaluating it. This
    # covers Task 6's own new names too: own_depth and frames_of are read by
    # `<<-` and ordinary lexical scoping respectively, both of which resolve
    # against the closure the driver defined them in before they ever reach
    # globalenv() — so a cell's own `own_depth` must not shadow the driver's.
    # capture_stack is Task 6's review-fix addition, named specifically so it
    # can identify its own frame later — the same containment applies to it.
    # Task 7's names are here too: `header`, `wanted` and `body` are what let a
    # read resume where a signal cut it short, `pending` is the cell in hand
    # and whether it has been started, and `terminate` and `release` are what
    # answer it and put its capture back. A cell that could reach any of them
    # could desynchronise the stream its own answer comes back on, or have its
    # own code run a second time.
    #
    # Bound as FUNCTIONS, not as strings. R skips a non-function binding when
    # it is looking for something to call, so a cell binding `emit <- 1` does
    # not test the hazard at all — it tests a name R would have walked past
    # anyway. Every finding on this plan about shadowing has been about a
    # binding in call position, and this is the shape that produces them.
    shadow = "; ".join(
        "%s <- function(...) stop('shadowed %s')" % (name, name)
        for name in (
            "emit",
            "captured",
            "captured_text",
            "run_cell",
            "read_source",
            "drain",
            "own_depth",
            "frames_of",
            "raised_calls",
            "capture_stack",
            "said",
            "warned",
            "header",
            "wanted",
            "body",
            "pending",
            "terminate",
            "release",
            "in_con",
            "out_con",
            "NEWLINE",
        )
    )
    records = _cell(driver, shadow + "; 'still here'")
    assert records[-1][0] == "ok"
    value = next(body for tag, body in _cell(driver, "1 + 1") if tag == "value")
    assert "2" in value.decode("utf-8")
    # And the traceback machinery those names belong to still works, reading
    # the driver's own own_depth rather than the cell's shadow of it.
    records = _cell(driver, "f <- function() stop('after shadow')\nf()")
    assert records[-1][0] == "fail"
    trace = next(body for tag, body in records if tag == "trace").decode("utf-8")
    assert "f()" in trace


def test_a_parse_failure_runs_nothing_and_reports_the_syntax_error_alone(driver):
    records = _cell(driver, "if (TRUE {")
    assert records[-1][0] == "fail"
    assert [tag for tag, _ in records] == ["error", "fail"]


def test_a_print_method_that_raises_before_the_last_statement_keeps_the_namespace(driver):
    # A half-written print method is the ordinary state of a class in the
    # middle of a session, and autoprinting one is the researcher's own code.
    # The last statement's rendering has always been guarded; this is every
    # statement before it, where an unguarded print ends the process — so the
    # cell gets no answer at all and the session loses every variable in it.
    _cell(driver, "print.boom <- function(x, ...) stop('print blew up')")
    records = _cell(driver, "structure(1, class = 'boom')\nsummary(1:3)")

    assert records[-1][0] == "ok"
    out = b"".join(body for tag, body in records if tag == "out").decode("utf-8")
    # The same placeholder the last statement's rendering falls back to, so a
    # value that will not print reads the same wherever it sat in the cell.
    assert "<a value this kernel could not render>" in out
    # The statement after it still ran, and its value still came back.
    value = next(body for tag, body in records if tag == "value").decode("utf-8")
    assert "Median" in value
    # And the kernel is still holding what it was given.
    assert "2" in next(
        body for tag, body in _cell(driver, "1 + 1") if tag == "value"
    ).decode("utf-8")


def test_a_raising_cell_terminates_rather_than_leaving_the_host_waiting(driver):
    records = _cell(driver, "stop('deliberate')")
    assert records[-1][0] == "fail"
    error = next(body for tag, body in records if tag == "error").decode("utf-8")
    assert "deliberate" in error
    # And the kernel runs the next cell.
    assert _cell(driver, "1 + 1")[-1][0] == "ok"


def test_a_traceback_holds_the_researchers_frames_and_none_of_the_drivers(driver):
    records = _cell(driver, "f <- function() g()\ng <- function() stop('inside')\nf()")
    assert records[-1][0] == "fail"
    trace = next(body for tag, body in records if tag == "trace").decode("utf-8")
    assert "f()" in trace
    assert "g()" in trace
    # A traceback showing the kernel's plumbing reads as the kernel being at
    # fault for the researcher's own error.
    for own in ("run_cell", "withCallingHandlers", "tryCatch", "doTryCatch", "eval("):
        assert own not in trace
    # frames_of()'s own reversal puts the deepest frame first, not last: the
    # calling handler this task registers to capture the stack leaves its
    # own invocation as that deepest frame, self-referentially named
    # "h(simpleError(msg, call))" by R's own dispatch internals. Removed by
    # identity, not by a frame count that would otherwise differ between a
    # plain stop() and a signalled condition object.
    assert "h(simpleError" not in trace
    # base::.handleSimpleError is the other frame this driver itself is the
    # reason for: it is what stop() uses to invoke a registered calling
    # handler at all, and there would be no such frame with no
    # withCallingHandlers(error = ...) here. Removed the same way, by
    # identity — leaving this trace exactly the researcher's own two frames,
    # nothing else.
    assert trace == "stop(\"inside\")\ng()\nf()"


def test_a_primitives_error_with_no_researcher_frame_emits_no_trace(driver):
    # log('a') is a primitive called directly at the cell's own top level, so
    # there is no closure of the researcher's to show at all -- own_depth's
    # bottom trim correctly leaves nothing above it. What remains is R's own
    # condition-dispatch machinery: this driver's own calling-handler frame,
    # and base::.handleSimpleError, the frame stop() uses to invoke it --
    # present only because this driver registered one. Both are removed by
    # identity, and asserted here by the actual shape that leaves, not by
    # the absence of one spelling among several: an assertion guarded behind
    # "if there is a trace record" passes vacuously when there is none, and
    # an assertion that only forbids "h(simpleError" passes even while
    # .handleSimpleError sits there unremoved. This is the same shape
    # test_a_subscript_error_with_no_researcher_frames_emits_no_trace
    # already proves for a different primitive error with no researcher
    # frame — log('a') must land there too.
    records = _cell(driver, "log('a')")
    assert records[-1][0] == "fail"
    assert not any(tag == "trace" for tag, _ in records)
    error = next(body for tag, body in records if tag == "error").decode("utf-8")
    assert "non-numeric argument to mathematical function" in error


def test_a_researcher_who_aliases_handleSimpleError_keeps_their_own_call_site(driver):
    # base::.handleSimpleError is reachable from any cell, unlike
    # capture_stack, which is a closure local to this driver's own run_cell
    # and which no cell can ever obtain a handle to. A researcher who
    # aliases it and calls it directly is calling the identical object this
    # driver's own trim matches against — so matching on function identity
    # alone would delete the researcher's own call site along with the
    # genuine dispatch frame it is impersonating.
    #
    # .handleSimpleError's own first formal is always named `h`; in the
    # genuine case — R actually invoking the handler this driver registered
    # — that argument is capture_stack. In the cell below it is the
    # researcher's own ad-hoc function instead, and their own call site,
    # `h(function(cond) stop('handled-boom'), 'msg', quote(somecall()))`,
    # must survive.
    records = _cell(
        driver,
        "h <- base::.handleSimpleError\n"
        "f <- function() h(function(cond) stop('handled-boom'), 'msg', quote(somecall()))\n"
        "f()",
    )
    assert records[-1][0] == "fail"
    trace = next(body for tag, body in records if tag == "trace").decode("utf-8")
    assert trace == (
        'stop("handled-boom")\n'
        "h(simpleError(msg, call))\n"
        'h(function(cond) stop("handled-boom"), "msg", quote(somecall()))\n'
        "f()"
    )


def test_a_cell_applying_the_handleSimpleError_alias_to_itself_still_gets_its_own_error(driver):
    # Telling the genuine dispatch frame from a researcher's own aliased call
    # means reading that frame's own `h` back out of it -- and reading a
    # binding is not inert. get0() forces what it finds, so a cell that passes
    # the alias to itself leaves that frame's `h` a promise already under
    # evaluation, and the read raises rather than answering.
    #
    # Unguarded, that abort lands inside the driver's own frame-identifying
    # vapply, before it has recorded anything, and costs the researcher both
    # halves of what a faithful failure is: no trace record is emitted at all,
    # and the error they are shown is the driver's own "promise already under
    # evaluation" complaint substituted for their real one. Both are asserted
    # here, because a guard that restored the traceback while still reporting
    # the wrong error would be no fix.
    records = _cell(
        driver,
        "h <- base::.handleSimpleError\nh(h, 'msg', quote(passself()))",
    )
    assert records[-1][0] == "fail"
    error = next(body for tag, body in records if tag == "error").decode("utf-8")
    # What this cell genuinely raises, confirmed by evaluating it outside this
    # driver entirely: R reaches .handleSimpleError's second, argument-less
    # invocation and cannot supply `msg`.
    assert error == 'getvarError\nargument "msg" is missing, with no default'
    assert "promise already under evaluation" not in error
    trace = next(body for tag, body in records if tag == "trace").decode("utf-8")
    lines = trace.split("\n")
    # Every one of these is the researcher's own: their call site outermost,
    # then the two re-entries their own alias makes, then the constructor that
    # actually raised. None can be proven to be this driver's -- the frame
    # whose `h` could not be read is kept, since an over-trim deletes a real
    # call site while an under-trim only shows one line more.
    assert lines[-1] == 'h(h, "msg", quote(passself()))'
    assert lines[-2] == "h(simpleError(msg, call))"
    assert lines[-3] == "h(simpleError(msg, call))"
    assert lines[-4] == "simpleError(msg, call)"
    assert _cell(driver, "1 + 1")[-1][0] == "ok"


def test_a_subscript_error_with_no_researcher_frames_emits_no_trace(driver):
    # l[[5]] raises from inside a primitive subscript operation with no
    # frame of the researcher's own on the stack at all. Once the driver's
    # own calling-handler frame -- the only entry own_depth's trim would
    # otherwise have left -- is removed by identity, nothing legitimate
    # remains to show, and no trace record is emitted at all rather than one
    # consisting solely of this driver's own machinery.
    records = _cell(driver, "l <- list(1)\nl[[5]]")
    assert records[-1][0] == "fail"
    assert not any(tag == "trace" for tag, _ in records)
    error = next(body for tag, body in records if tag == "error").decode("utf-8")
    assert "subscript out of bounds" in error


def test_shadowing_rev_vapply_sys_calls_class_or_identical_does_not_kill_the_kernel(driver):
    # local()'s enclosing environment is globalenv(), so a cell's own `rev`,
    # `vapply`, `sys.calls`, `class`, or `identical` -- bound as functions,
    # the shape that actually breaks an unqualified call -- would otherwise
    # be read by this driver's own machinery in place of base's. This is the
    # exact failure mode the constraints name as having killed a previous
    # attempt, one indirection out: not the driver's own names being
    # rebound, but the base functions it calls without base:: to render a
    # researcher's own error back to them. `identical` is exercised twice
    # over by the cell that follows: once inside capture_stack's own frame
    # identification, and once inside read_source's header parsing that has
    # to succeed before that cell can even be received.
    records = _cell(
        driver,
        "rev <- function(...) stop('shadowed rev')\n"
        "vapply <- function(...) stop('shadowed vapply')\n"
        "sys.calls <- function(...) stop('shadowed sys.calls')\n"
        "class <- function(...) stop('shadowed class')\n"
        "identical <- function(...) stop('shadowed identical')\n"
        "'still here'",
    )
    assert records[-1][0] == "ok"
    records = _cell(driver, "f <- function() g()\ng <- function() stop('after shadow')\nf()")
    assert records[-1][0] == "fail"
    trace = next(body for tag, body in records if tag == "trace").decode("utf-8")
    assert trace == "stop(\"after shadow\")\ng()\nf()"
    assert _cell(driver, "1 + 1")[-1][0] == "ok"


@pytest.mark.parametrize(
    "shadow",
    (
        "charToRaw <- function(...) raw(0)",
        "flush <- function(...) NULL",
        "paste0 <- function(...) ''",
        "writeBin <- function(...) NULL",
    ),
)
def test_a_cell_that_quietly_rebinds_what_emit_calls_leaves_the_kernel_answering(shadow):
    # emit is the only way anything this kernel has to say reaches the host,
    # so a name it calls unqualified is not one traceback at risk — it is the
    # kernel's voice. This is the failure this whole file exists to keep out:
    # the process alive, the host blocked on a terminator nobody is left to
    # write, and a turn that never ends.
    #
    # The shadows below RETURN QUIETLY rather than raise, and that is the
    # whole point of writing them out one by one instead of reusing the
    # `function(...) stop(...)` shape the shadowing tests above use. A raising
    # shadow is the safe shape: it takes the kernel down inside emit, the
    # process exits, the host reads the end of a stream and reports a kernel
    # that stopped — an honest answer. A shadow that politely produces
    # nothing is the dangerous one, because emit then writes no bytes and
    # returns as though it had. Measured against this driver before the
    # base:: qualification, one fresh kernel per name: all four of these left
    # the process ALIVE and answering nothing at all, on the FIRST cell.
    #
    # A fresh process per name, and its own rather than the fixture's, for the
    # same reason the sustained-interrupt test below has one: a wedge is not
    # recoverable, so nothing after it in the same kernel would mean anything.
    # And the records are pulled by a thread with a deadline rather than read
    # in line, because a wedge read in line hangs the suite instead of failing
    # it — the exact substitution of silence for a failure that the defect
    # itself performs on a researcher.
    if RSCRIPT is None:
        pytest.skip("this machine has no Rscript, so it holds no R kernels")
    process = subprocess.Popen(
        [RSCRIPT, "--vanilla", DRIVER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    records: queue.Queue = queue.Queue()

    def reading(stream=process.stdout) -> None:
        while True:
            header = stream.readline()
            if not header:
                records.put(None)
                return
            tag, _, count = header.decode("utf-8", "replace").strip().partition(" ")
            try:
                length = int(count)
            except ValueError:
                records.put(None)
                return
            records.put((tag, _exactly(stream, length).decode("utf-8", "replace")))

    def answered(source: str) -> tuple[str, list[tuple[str, str]]]:
        payload = source.encode("utf-8")
        process.stdin.write(b"%d\n" % len(payload) + payload)
        process.stdin.flush()
        seen: list[tuple[str, str]] = []
        while True:
            try:
                record = records.get(timeout=10)
            except queue.Empty:
                return "wedged", seen
            if record is None:
                return "stopped", seen
            seen.append(record)
            if record[0] in ("ok", "fail"):
                return "answered", seen

    threading.Thread(target=reading, daemon=True).start()
    try:
        assert records.get(timeout=10)[0] == "ready"
        bound, _ = answered(shadow)
        assert bound == "answered", f"binding it left the kernel {bound}"
        verdict, seen = answered("1 + 1")
        assert verdict == "answered", f"the cell after it left the kernel {verdict}"
        assert any(tag == "value" and "2" in body for tag, body in seen)
    finally:
        # Ended before its streams are closed, so the reader above finds the
        # end of one rather than one taken out from under it mid-read.
        process.kill()
        process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                stream.close()
            except OSError:
                pass


def test_a_researchers_own_h_and_doTryCatch_survive_their_own_traceback(driver):
    # The trim matches frames by position from the driver's own stack, not by
    # spelling. Cutting every frame called `h` or `doTryCatch` would delete
    # the researcher's functions of those names.
    records = _cell(
        driver,
        "h <- function() doTryCatch()\ndoTryCatch <- function() stop('mine')\nh()",
    )
    trace = next(body for tag, body in records if tag == "trace").decode("utf-8")
    assert "h()" in trace
    assert "doTryCatch()" in trace


def test_the_conditions_class_names_the_error(driver):
    records = _cell(driver, "stop('plain')")
    error = next(body for tag, body in records if tag == "error").decode("utf-8")
    assert "plain" in error


def test_a_conditionMessage_method_that_raises_does_not_kill_the_kernel(driver):
    # conditionMessage() is itself an S3 generic — the same trap Task 4 had
    # to close for print(). A custom condition class whose own
    # conditionMessage.<class> method raises must not take the kernel down
    # over a message it was only being asked to render.
    #
    # A method that always raises never reaches this guard at all: R's own
    # stop() computes conditionMessage() on a bare condition object *before*
    # signalling it, so an unconditional failure there replaces the
    # researcher's condition with a plain simpleError before run_cell ever
    # sees it — verified by hand against this driver. The method below
    # succeeds the first time (satisfying stop()'s own precomputation, so
    # the "boom" class survives to reach run_cell's failure handling) and
    # only raises the second time, when this file's own emission code asks
    # it to describe the condition again.
    records = _cell(
        driver,
        "calls <- 0\n"
        "conditionMessage.boom <- function(c) {\n"
        "  calls <<- calls + 1\n"
        "  if (calls == 1) return('first-call message')\n"
        "  stop('second-call blew up')\n"
        "}\n"
        "err <- structure(class = c('boom', 'error', 'condition'), list(message = 'unused', call = NULL))\n"
        "stop(err)",
    )
    assert records[-1][0] == "fail"
    error = next(body for tag, body in records if tag == "error").decode("utf-8")
    # The class survived even though describing it did not.
    assert error.startswith("boom\n")
    assert "<a message this kernel could not render>" in error
    # And the kernel is still holding what it was given.
    assert _cell(driver, "1 + 1")[-1][0] == "ok"


def test_out_and_err_arrive_in_the_order_the_cell_produced_them(driver):
    records = _cell(
        driver,
        "cat('one\\n')\nmessage('two')\ncat('three\\n')\nwarning('four')\ncat('five\\n')",
    )
    assert records[-1][0] == "ok"
    ordered = [
        (tag, body.decode("utf-8")) for tag, body in records if tag in ("out", "err")
    ]
    assert [tag for tag, _ in ordered] == ["out", "err", "out", "err", "out"]
    assert "one" in ordered[0][1]
    assert "two" in ordered[1][1]
    assert "three" in ordered[2][1]
    # R defers warnings to end-of-cell under the default warn = 0, so a plain
    # sink would report this after all output regardless of where it was
    # raised. The calling handler is what puts it here.
    assert "four" in ordered[3][1]
    assert "five" in ordered[4][1]


def test_a_cell_printing_a_great_deal_does_not_lose_the_front_of_it(driver):
    # The drain keeps an emitted-count and slices forward, because
    # textConnection(var, "w") LOCKS the binding: clearing the variable raises
    # `cannot change value of locked binding`, so the obvious implementation
    # does not run at all.
    records = _cell(driver, "for (i in 1:200) cat(i, '\\n')")
    assert records[-1][0] == "ok"
    out = "".join(body.decode("utf-8") for tag, body in records if tag == "out")
    assert out.split()[0] == "1"
    assert out.split()[-1] == "200"


def test_a_partial_line_lands_with_the_text_that_finishes_it(driver):
    # A complete line ahead of a partial one, both drained by the same
    # message-triggered pass: `cat('one\n')` is already whole by the time
    # `cat('two')` leaves the connection mid-line, and `message('m')` drains
    # before `cat('three\n')` ever runs to finish "two". Checked against the
    # exact joined string rather than mere membership — a drain that asks
    # isIncomplete() about the *next*, not-yet-drained chunk instead of the
    # one it is actually emitting silently swallows the newline that
    # terminated "one", and `"half" in joined`-style membership would not
    # have noticed.
    records = _cell(driver, "cat('one\\n')\ncat('two')\nmessage('m')\ncat('three\\n')")
    ordered = [(tag, body.decode("utf-8")) for tag, body in records if tag in ("out", "err")]
    assert ("err", "m\n") in ordered
    joined = "".join(text for tag, text in ordered if tag == "out")
    assert joined == "one\ntwothree\n"


def test_the_driver_leaves_nothing_of_its_own_in_the_researchers_namespace(driver):
    # The other half of local(), and the half that is easy to lose: `<<-` at
    # local()'s own top level does NOT write the closure, because the closure
    # is already the current environment — it walks one further out, which is
    # globalenv(), and puts the driver's own bookkeeping in the researcher's
    # namespace. Written as an exact listing rather than a check for one
    # spelling, so anything this driver ever leaves behind fails here by name.
    _cell(driver, "mine <- 1")
    value = next(
        body for tag, body in _cell(driver, "ls(globalenv())") if tag == "value"
    ).decode("utf-8")
    assert value == '[1] "mine"'


def test_a_stream_that_has_slipped_stops_the_driver_rather_than_wedging_the_host(driver):
    # The one outcome worth trading anything to avoid. A signal can take a
    # byte off this stream between the read that got it and the assignment
    # that would have kept it — base R offers no way to hold a signal off, so
    # the window can be narrowed and not closed — and a count read short takes
    # the rest of its own cell for the next count. From there this end reads
    # on for a newline that is never coming while the host waits on a
    # terminator that is never coming, and nothing short of restarting the
    # machine ends it.
    #
    # A header is digits and then a newline, so the slip is detectable at the
    # first byte that is neither. Written below by hand rather than raced for:
    # a count, and then bytes that are not a count, which is exactly the state
    # a lost digit leaves behind.
    driver.stdin.write(b"5cat('x')")
    driver.stdin.flush()

    watching = selectors.DefaultSelector()
    watching.register(driver.stdout, selectors.EVENT_READ)
    assert watching.select(timeout=5), "the driver neither answered nor stopped"
    # Stopped, and said so by closing its stream — which the host reports as a
    # kernel that stopped, ending the turn rather than holding it open.
    assert driver.stdout.readline() == b""


def test_the_driver_says_when_it_is_inside_a_cell(driver):
    records = _cell(driver, "1 + 1")
    assert records[0][0] == "run"


def test_a_parse_failure_never_says_it_is_running(driver):
    # The host, having seen no `run`, never signals a process that is doing
    # nothing.
    records = _cell(driver, "if (TRUE {")
    assert [tag for tag, _ in records] == ["error", "fail"]


def test_a_cell_delivered_in_two_writes_around_a_signal_still_arrives_whole(driver):
    # Named for what it checks, which is not what it was first named for. It
    # was written to prove the read RESUMES rather than restarts, and it does
    # not: a mutation clearing the read state at every entry — the
    # restart-from-scratch behaviour it was meant to guard against — passes
    # this 12 times out of 12. Measured, not assumed. The reason is that the
    # signal does not surface where the earlier comment claimed: against a
    # two-byte header there are too few of R's own check points in the read's
    # byte loop for the raise to land there, and it comes up well inside
    # run_cell instead. Read idempotency is exercised by the sustained-signal
    # test at the foot of this file, and by nothing else here.
    #
    # What this does check is still worth checking, and it is the shape a host
    # writing across a slow pipe would produce: a cell whose bytes arrive in
    # two writes with a signal in between is answered, and answered with the
    # cell that was sent rather than a fragment of it.
    payload = b"cat('resumed\\n')"
    header = b"%d" % len(payload)
    driver.stdin.write(header[:1])
    driver.stdin.flush()
    time.sleep(0.1)
    driver.send_signal(signal.SIGINT)
    time.sleep(0.05)
    driver.stdin.write(header[1:] + b"\n" + payload)
    driver.stdin.flush()

    records: list[tuple[str, bytes]] = []
    while True:
        tag, body = _record(driver)
        records.append((tag, body))
        if tag in ("ok", "fail"):
            break
    # Where a pending signal surfaces is R's business, not this driver's, so
    # whether this cell comes back `ok` or reports the signal is not asserted.
    # What is asserted is that the cell was ENTERED, and that is exactly the
    # discriminating fact: a read that began again from the middle would have
    # taken `5` for the count and handed `cat('` to the parser, and a parse
    # failure never reaches the `run` record. Answered either way, and never
    # answered with a syntax error the researcher did not write.
    assert ("run", b"") in records
    assert records[-1][0] in ("ok", "fail")
    for tag, body in records:
        if tag == "error":
            assert body.decode("utf-8").startswith("lykeionInterrupt")
    # And the driver goes on holding the namespace it was given.
    assert _cell(driver, "1 + 1")[-1][0] == "ok"


def test_sustained_interrupting_never_runs_a_cell_twice_or_goes_silent(tmp_path):
    # The one test in this file that hunts rather than checks, and the only
    # one that needs its own process rather than the fixture's: it interrupts
    # faster than cells finish, and a kernel that stops and says so under that
    # is an honest outcome, so it starts another and carries on.
    #
    # It runs against the driver directly, not through RKernel, and that is
    # not a shortcut. The host's gate and the milliseconds `alive()` spends
    # asking the platform about a pid change the timing enough that the defect
    # this guards against — a cell handed to run_cell a second time — did not
    # reproduce in 1,200 cells through the host while reproducing in 4 runs
    # out of 6 here. A regression detector belongs where the regression lives.
    #
    # What is asserted is never survival, only that the driver does not lie:
    #
    #   * it never goes silent with a cell outstanding, which is the wedge —
    #     and would hang the suite rather than fail it, so a watchdog turns it
    #     into a failure;
    #   * it never runs a cell twice, counted by execution in the ledger below
    #     rather than by answer, because the whole harm of running twice is
    #     that the answer does not show it;
    #   * it never answers one cell with another's value, which is what a
    #     stream that has slipped looks like from above.
    if RSCRIPT is None:
        pytest.skip("this machine has no Rscript, so it holds no R kernels")

    ledger = tmp_path / "ran.txt"
    wanted = 1000
    done = 0
    wedged = threading.Event()

    while done < wanted:
        process = subprocess.Popen(
            [RSCRIPT, "--vanilla", DRIVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        # Records are pulled by a thread rather than read on demand: a wedge
        # has to be a failure, and a blocking read cannot be given a deadline.
        records: queue.Queue = queue.Queue()

        def reading(stream=process.stdout) -> None:
            while True:
                header = stream.readline()
                if not header:
                    records.put(None)
                    return
                tag, _, count = header.decode("utf-8").strip().partition(" ")
                records.put((tag, _exactly(stream, int(count)).decode("utf-8")))

        stop = threading.Event()

        def hammering(pid: int = process.pid) -> None:
            while not stop.is_set():
                try:
                    os.kill(pid, signal.SIGINT)
                except (ProcessLookupError, OSError):
                    return
                time.sleep(0.002)

        threading.Thread(target=reading, daemon=True).start()
        assert records.get(timeout=10)[0] == "ready"
        threading.Thread(target=hammering, daemon=True).start()

        try:
            while done < wanted:
                source = (
                    f"cat('{done}\\n', file = {str(ledger)!r}, append = TRUE)\n"
                    f"Sys.sleep(0.02)\n"
                    f"{done}"
                ).encode("utf-8")
                try:
                    process.stdin.write(b"%d\n" % len(source) + source)
                    process.stdin.flush()
                except (BrokenPipeError, ValueError):
                    break
                answered = None
                value = None
                entries = 0
                while answered is None:
                    try:
                        record = records.get(timeout=30)
                    except queue.Empty:
                        wedged.set()
                        break
                    if record is None:
                        break
                    if record[0] == "run":
                        entries += 1
                    elif record[0] == "value":
                        value = record[1]
                    elif record[0] in ("ok", "fail"):
                        answered = record[0]
                if wedged.is_set():
                    break
                if answered is None:
                    break  # the driver stopped and said so; another one, and on
                # Two `run` records for one submission is run_cell entered
                # twice on the same source, and it is the sharper reading of
                # the two: a second entry cut short before it reached the
                # ledger write leaves no trace in the file at all, and would
                # be a cell half-executed with nothing to show for it.
                assert entries <= 1, f"cell {done} was started {entries} times"
                if answered == "ok":
                    assert value is not None and value.strip().endswith(str(done)), (
                        f"cell {done} was answered with {value!r}"
                    )
                done += 1
        finally:
            stop.set()
            for stream in (process.stdin, process.stdout, process.stderr):
                try:
                    stream.close()
                except OSError:
                    pass
            process.kill()
            process.wait()
        if wedged.is_set():
            break

    assert not wedged.is_set(), "the driver went silent with a cell outstanding"
    ran = ledger.read_text().split()
    twice = sorted({line for line in ran if ran.count(line) > 1}, key=int)
    assert twice == [], f"these cells executed more than once: {twice}"
