# The code an R kernel process itself runs: one namespace, one cell at a time.
#
# Started inside the boundary the daemon rendered and spoken to over its own
# stdin and stdout. Records are length-prefixed bytes rather than JSON: base R
# ships no JSON reader or writer, jsonlite is a CRAN package, and "whatever R
# the machine has" may not have it. Reading and writing an exact byte count is
# the one thing base R does perfectly, needs no parser on either side, and
# cannot be broken by a newline or a quote inside a cell.
#
# Base-only and Unix-only. Records go to /dev/stdout, for which base R offers
# no portable alternative, and anything beyond base is written pkg::name.
#
# Every binding this file makes lives inside the local() below. The namespace a
# cell is handed is the researcher's alone: a cell binding `emit` or `captured`
# in globalenv() must not replace the machinery evaluating it.

local({
  out_con <- file("/dev/stdout", "wb", raw = TRUE)
  in_con <- file("stdin", "rb")

  # One write rather than the header and the body separately. Every writeBin
  # is a place a signal can cut a record in half, and half a record is the one
  # thing the host cannot recover from — it reads the remains as the next
  # record's header, fails to parse it, and calls the kernel crashed. The
  # window cannot be closed from base R, which offers no way to hold a signal
  # off, but it can be halved, and this halves it.
  #
  # Every call here is written base::, and this function earns that before any
  # other in the file does: it is the ONLY way anything this kernel has to say
  # reaches the host, so a cell that shadows a name used here silences the
  # kernel rather than merely spoiling one traceback. Silence is the failure
  # this driver trades everything to avoid. Measured, one fresh kernel per
  # name, against a shadow that returns quietly instead of raising —
  # `charToRaw <- function(...) raw(0)`, `flush <- function(...) NULL`,
  # `paste0 <- function(...) ''`, `writeBin <- function(...) NULL` — and all
  # four left the process ALIVE and answering nothing at all, the host blocked
  # on a terminator no one was left to write. A shadow that raises is not the
  # dangerous shape: it takes the kernel down, which the host reports. A
  # shadow that answers politely with nothing is the wedge, and only base::
  # keeps it out of here. `c` and `length` are qualified alongside the four
  # for the same reason and not because they were seen to fail: they are read
  # in call position on this line too, and the price of finding out which of
  # them a researcher happens to bind is a session nobody can end.
  emit <- function(tag, text = "") {
    bytes <- base::charToRaw(base::enc2utf8(text))
    counted <- base::charToRaw(base::paste0(tag, " ", base::length(bytes), "\n"))
    base::writeBin(base::c(counted, bytes), out_con)
    base::flush(out_con)
  }

  # What has already been taken off the stream for the cell now being read.
  # Held out here, in the closure, rather than inside read_source, because a
  # signal can cut that read short part-way through — and a read that then
  # started over would take the front of a cell's own source for the count
  # that precedes it, leaving this end waiting on a newline that is never
  # coming while the host waits on a terminator that is never coming either.
  # That is the wedge, arrived at from the other side. Kept here, a read
  # resumed after a signal goes on from exactly where it stopped, and no byte
  # this driver has taken is ever read twice or dropped.
  header <- base::raw(0)
  wanted <- NULL
  body <- base::raw(0)
  NEWLINE <- base::as.raw(10L)

  # The header is read a byte at a time because the body that follows it is
  # counted in bytes: a reader that buffered a line would consume the front of
  # the source along with it.
  #
  # Nothing here is cleared on the way out, and that is the whole design: this
  # read is IDEMPOTENT between one terminator and the next. Called again after
  # a signal cut it short, it picks up whatever was already taken and returns
  # the same cell it would have returned — so there is no instant at which a
  # cell has been consumed off the stream and is not yet anywhere. terminate()
  # is what resets all three, once the cell they describe has been answered.
  read_source <- function() {
    if (base::is.null(wanted)) {
      repeat {
        # The read feeds the accumulator directly, with no variable of its own
        # in between, and both tests come after. A byte taken off the stream
        # and not recorded is a byte gone for good, and the one that costs
        # everything is the newline: lose it and this end reads on through the
        # cell's own source looking for a newline that is never coming, while
        # the host waits on an answer nothing is left to write. That is the
        # wedge. R checks for a signal between statements far more readily
        # than within one, so the read and the keeping of what it read are one
        # assignment rather than two statements — the narrowest this can be
        # made from base R, which offers no way to hold a signal off at all.
        was <- length(header)
        header <<- c(header, readBin(in_con, "raw", n = 1L))
        # Nothing came, so the host has closed its end and this kernel's day
        # is over. Under a signal arriving faster than this can block, R will
        # also hand back an empty result on an open stream — measured — and
        # this end reads that as the same thing and stops. Told apart it
        # cannot be: base R offers no way to ask a connection which of the two
        # just happened. Stopping is the safe reading of the pair, because the
        # host hears a kernel that stopped either way, which is a turn ended
        # rather than a turn held open for ever.
        if (length(header) == was) return(NULL)
        # base:: for the same reason capture_stack's own identity checks are:
        # this runs before every cell is even read, so an unqualified call
        # shadowed by a previous cell's own `identical` would break the very
        # next cell sent to this kernel, not just a traceback inside one.
        if (base::identical(header[length(header)], NEWLINE)) break
        # The window above cannot be closed from base R, only narrowed — so
        # this end is also taught to recognise having fallen through it. A
        # header is decimal digits and then a newline, and nothing else, ever.
        # Any other byte here is proof of having lost the place: a digit
        # dropped from a count reads a cell short, the remainder of that cell
        # is then taken for the next count, and this kernel limps a cell
        # behind the host until it stops on a payload with no newline in it.
        # That is the wedge, and it is exactly what was measured — three times
        # out of three, by asking a stuck kernel what it was waiting for and
        # being told: a header newline.
        #
        # There is no resynchronising from here; nothing in the bytes says
        # where the next cell begins. So this end stops instead, and the host
        # says the kernel stopped. That trade is the whole point of the task.
        # A reported death costs a researcher their namespace and tells them
        # so. A wedge costs the same namespace while the kernel goes on
        # telling the lab it is alive and the turn goes on running, and only
        # restarting the machine ends it.
        #
        # The length bound beside it is for the one shape the digit test
        # cannot see: a count whose newline went missing followed by a payload
        # that happens to begin with digits.
        code <- base::as.integer(header[length(header)])
        if (code < 48L || code > 57L) return(NULL)
        if (length(header) > 32L) return(NULL)
      }
      # The newline itself is not part of the count, and a header this end
      # cannot make sense of asks for nothing: an empty cell, which run_cell
      # answers with an ordinary `ok`. It must not be skipped — the host has
      # counted it and is already waiting on its terminator.
      count <- suppressWarnings(as.integer(base::rawToChar(header[-length(header)])))
      if (is.na(count) || count < 0L) count <- 0L
      wanted <<- count
    }
    if (wanted > 0L) {
      # A loop rather than the single read this was, and the read inside the
      # assignment for the same reason as above: what has arrived is kept, so
      # a signal cutting this short costs nothing but the retry. A blocking
      # connection returns short only at the end of the stream, and the host
      # writes a header and its payload in ONE write, so by the time a body is
      # being read every byte of it is already in the pipe — in the ordinary
      # case this goes round exactly once.
      repeat {
        was <- length(body)
        body <<- c(body, readBin(in_con, "raw", n = wanted - length(body)))
        if (length(body) == was) return(NULL)
        if (length(body) >= wanted) break
      }
    }
    text <- base::rawToChar(body)
    Encoding(text) <- "UTF-8"
    text
  }

  # How deep the driver's own frames go before a cell's first frame begins.
  # Measured at the moment of the error rather than assumed: what is trimmed
  # is everything at or below the driver's own depth, so a researcher's
  # function keeps its name whatever they called it.
  own_depth <- NULL

  frames_of <- function(calls) {
    if (is.null(own_depth) || length(calls) <= own_depth) return(character(0))
    kept <- calls[(own_depth + 1L):length(calls)]
    # base:: because local()'s enclosing environment is globalenv(): a cell
    # that has bound its own `rev` or `vapply` by the time a later cell
    # raises would otherwise be read here in place of base's, and take the
    # kernel down over rendering a traceback rather than running one.
    base::vapply(
      base::rev(kept),
      function(one) {
        rendered <- tryCatch(deparse(one), error = function(cond) "<a call this kernel could not render>")
        # deparse() splits a long or multi-line call across elements; the
        # first line is what a traceback shows, and the truncation is stated
        # rather than hidden.
        rendered[[1L]]
      },
      character(1)
    )
  }

  # The cell this driver has taken off the stream and not yet answered, and
  # the whole of what the loop below needs to remember. Three states in one
  # binding:
  #
  #   NULL           nothing is owed — read the next cell
  #   the source     a cell is owed and has NOT been handed to run_cell
  #   TRUE           a cell is owed and WAS handed to run_cell; it may only
  #                  be answered now, never run again
  #
  # One binding rather than a source with a flag beside it, and that is not
  # tidiness. Two bindings have an instant between them where a signal can
  # land, and one half of that instant hands a cell to run_cell twice. It is
  # worth being plain about why that is the worst outcome in this file, worse
  # than a wedge and far worse than a reported death: a cell that appends a
  # row, writes a file, posts to a database or bumps a counter would do it
  # again, silently, and then be reported FAILED — so the researcher believes
  # it did not happen at all. Nothing else here can produce a wrong number
  # and hide it.
  #
  # So `pending <- TRUE` is written BEFORE the call it describes rather than
  # after. A signal in that gap costs a cell that had not started yet the
  # chance to run, and it is answered as interrupted instead. That is the
  # direction to err in: an interrupt reported for a cell that did nothing is
  # a true statement about a cell nobody was promised.
  pending <- NULL

  # Writing a terminator is the one act that ends a cell, so it is also the one
  # place the read state is thrown away. `pending` goes last: a signal landing
  # part-way through leaves this end still owing an answer, which it may write
  # twice and the host can at worst misread, rather than clearing the debt
  # while the read state still describes a cell — which would hand the same
  # bytes back as the next cell. Neither half can hand a cell to run_cell
  # twice, because by the time any terminator is written `pending` is TRUE.
  terminate <- function(tag) {
    emit(tag)
    header <<- base::raw(0)
    wanted <<- NULL
    body <<- base::raw(0)
    pending <<- NULL
  }

  run_cell <- function(source) {
    parsed <- tryCatch(parse(text = source), error = function(cond) cond)
    if (inherits(parsed, "condition")) {
      # Nothing ran, so there is no output and no frame of the researcher's.
      # Class-prefixed the same way a failure from actually running the cell
      # is below: r.py's `error` reader has read `class\nmessage` since this
      # task, and a parse failure emitted here without that prefix would have
      # its own diagnosis ("unexpected '{'") read as part of the class and
      # dropped from what the researcher is shown, keeping only the caret
      # diagram underneath it.
      emit("error", paste0(base::class(parsed)[[1L]], "\n", conditionMessage(parsed)))
      terminate("fail")
      return(invisible(NULL))
    }

    released <- FALSE
    emitted <- 0L

    # textConnection(var, "w") LOCKS its binding, so clearing the variable
    # raises `cannot change value of locked binding` — the obvious drain does
    # not run. What works is keeping a count of what has been emitted and
    # slicing forward from it.
    #
    # `unterminated` defaults to NULL, and NULL means something specific:
    # `captured_text` only ever holds lines the connection has already
    # completed — a pending partial chunk (no newline yet) stays buffered
    # inside the connection and is simply absent from the vector, not
    # present-but-ambiguous. So every mid-cell call, where a message or
    # warning fires with `captured` still open, is draining lines that are
    # already known-terminated by construction; NULL is not "go ask the
    # connection", it is "these are all complete, so terminate them". Asking
    # `isIncomplete()` there would answer a question about the *next*,
    # not-yet-drained chunk instead of the one being emitted, and wrongly
    # withhold a newline that genuinely belongs to this slice.
    #
    # The one call this doesn't describe is the final one, below, taken after
    # `close(captured)`. `close()` is what flushes a truly unterminated
    # trailing chunk into `captured_text` in the first place — and it also
    # invalidates the connection, so `isIncomplete()` can no longer be asked
    # of it by then. That call passes the real TRUE/FALSE verdict, captured a
    # moment earlier while the connection could still answer.
    drain <- function(unterminated = NULL) {
      lines <- captured_text
      if (length(lines) > emitted) {
        text <- paste(lines[(emitted + 1L):length(lines)], collapse = "\n")
        # A cell ending mid-line — `cat('hi')` with no newline — must come back
        # exactly as it was written, the way Python's `print('hi', end='')`
        # does. Only the final drain, above, ever passes a real verdict here;
        # `isTRUE(NULL)` is FALSE, so every mid-cell drain always terminates
        # what it emits, and only a remembered TRUE — a cell that truly ended
        # without a newline — withholds one.
        if (!isTRUE(unterminated)) text <- paste0(text, "\n")
        emitted <<- length(lines)
        emit("out", text)
      }
      invisible(NULL)
    }

    # Everything the capture above has to have undone, in one place and at
    # most once — because there are two ways out of this cell now, its own
    # last statement and a signal unwinding the frame from the handler the
    # loop below installs, and both must leave the same kernel behind. Called
    # plainly on the way out of a cell that ended of its own accord, and by
    # on.exit for every other way out; `released` is what keeps the second
    # call from popping a sink this cell no longer holds.
    release <- function() {
      if (released) return(invisible(NULL))
      released <<- TRUE
      sink()
      # The order matters and is not stylistic, in both directions. Asked
      # here, while the connection is still open: close() invalidates it, and
      # isIncomplete() on a closed connection raises "invalid connection"
      # rather than answering. Closed here, before the drain that follows:
      # close() is what flushes a truly unterminated trailing chunk into
      # captured_text in the first place, so a drain taken before it would
      # find that chunk simply absent — not ambiguous, missing — and silently
      # lose the tail of a cell whose last line never got a newline. The drain
      # that follows is handed the verdict captured a moment ago, because the
      # connection it would otherwise ask no longer exists to answer.
      unterminated <- isIncomplete(captured)
      close(captured)
      drain(unterminated)
    }

    # Captured from the first version of this file, not from the slice that
    # makes ordering faithful: the framing channel IS stdout, so an uncaptured
    # print() would corrupt the record stream rather than merely lose output.
    #
    # These three lines are in this order and no other, and the reason is a
    # signal. on.exit is registered after the connection it will close and
    # before the sink it will pop, so there is no instant at which either is
    # beyond the reach of the thing that puts it back. And release() is
    # defined ABOVE rather than below, because on.exit does not look its
    # expression up until the moment it runs: a signal landing while `release`
    # was still a forward reference brought the kernel down with `could not
    # find function "release"` — found by the stress below, 1 run in 12,
    # rather than reasoned about.
    captured <- textConnection("captured_text", "w", local = TRUE)
    base::on.exit(release())
    sink(captured)

    # Caught at the moment they are signalled rather than collected at the
    # end. R defers warnings to end-of-cell under the default warn = 0, so a
    # plain sink would report every warning after all output regardless of
    # where it was raised. Each one drains the stdout accumulated before it
    # first, so the two streams come back interleaved the way the cell
    # produced them.
    said <- function(cond) {
      drain()
      emit("err", conditionMessage(cond))
      invokeRestart("muffleMessage")
    }
    warned <- function(cond) {
      drain()
      emit("err", paste0("Warning message:\n", conditionMessage(cond), "\n"))
      invokeRestart("muffleWarning")
    }

    failure <- NULL
    raised_calls <- NULL
    value <- NULL
    has_value <- FALSE
    count <- length(parsed)
    # Measured here, immediately before the loop that runs the researcher's
    # own code, so the depth recorded is this call's — not a figure carried
    # over from wherever run_cell happened to be invoked from. The offset is
    # 8, not the 2 a reading of withCallingHandlers and withVisible alone
    # would suggest: tryCatch() itself unfolds into tryCatchList,
    # tryCatchOne, and doTryCatch before withCallingHandlers and withVisible
    # are reached, and eval() of a language object shows up twice on R
    # 4.6.1's stack rather than once. Measured directly against R rather than
    # assumed — a bare stop(), one nested two deep, and one nested five deep
    # were all sent through this same driver and their traceback's first kept
    # frame was, in every case, the researcher's own outermost call.
    #
    # It counts only the plumbing that stands BETWEEN this line and the
    # researcher's own first frame, which is why it survives the handler the
    # loop at the foot of this file wraps every run_cell in: those four frames
    # sit below this one and are already in the count taken here. What does
    # move it is anything added above — briefly, while the loop's own tryCatch
    # named a second handler, this was 11, because tryCatchList recurses once
    # per handler name and lays a whole further tryCatchList, tryCatchOne and
    # doTryCatch beneath the first. Measured, three frames exactly. A wrong
    # figure here is not loud; it just puts this driver's frames back into a
    # researcher's traceback.
    own_depth <<- length(base::sys.calls()) + 8L

    # Captures the stack while it is still standing — by the time tryCatch's
    # own exiting handler runs, every frame below has already unwound — and
    # named, rather than left as an anonymous literal, purely so its own
    # frame can be picked back out afterward by what it IS. sys.calls() is
    # asked from inside this function, so this function's own frame is
    # always present in what comes back, and is always driver machinery, not
    # the researcher's. base::.handleSimpleError is the other frame this
    # kernel itself is the reason for: it is what stop() calls to invoke a
    # registered calling handler at all, present only because this driver
    # registered one — with no withCallingHandlers(error = ...) here there
    # would be no such frame. Both are identified by what they ARE, not by
    # how many of them there are: that count varies with how the error was
    # raised (a bare stop() and a signalled condition object don't dispatch
    # through the same internals), while identity does not need to know.
    #
    # But base::.handleSimpleError is reachable from any cell — unlike
    # capture_stack, a closure local to this call and unaliasable by a cell
    # — so a researcher's own `h <- base::.handleSimpleError; h(f, msg,
    # call)` calls the identical object, and matching on function identity
    # alone would delete the researcher's own call-site frame along with the
    # genuine one. What tells them apart is .handleSimpleError's own first
    # formal, always named `h`: in the genuine case — R invoking the handler
    # this driver actually registered — that argument, read back out of the
    # frame's own environment, IS capture_stack. In the researcher's own
    # call, it is whatever they passed instead. inherits = FALSE keeps that
    # read to the one frame's own binding, so a researcher's unrelated `h`
    # bound further out — globalenv(), say — can never be reached by
    # inheritance and mistaken for the genuine argument.
    capture_stack <- function(cond) {
      calls <- base::sys.calls()
      mine <- base::vapply(
        base::seq_along(calls),
        function(k) {
          fn <- base::sys.function(k)
          if (base::identical(fn, capture_stack)) return(TRUE)
          if (!base::identical(fn, base::.handleSimpleError)) return(FALSE)
          # Reading a binding is not inert. get0() answers rather than raises
          # when the name is absent, but when it is present it FORCES it — and
          # a cell that applies the alias to itself, `h <- base::
          # .handleSimpleError; h(h, 'msg', quote(passself()))`, leaves that
          # frame's own `h` a promise already under evaluation, so the read
          # raises "promise already under evaluation" rather than answering.
          # Unguarded that abort lands inside this vapply, before raised_calls
          # is ever assigned, and costs the researcher both halves of what
          # this task exists to give them: no trace record is emitted at all,
          # and the message they are shown is this driver's promise-recursion
          # complaint in place of their own error. Guarded exactly as print(),
          # conditionMessage() and deparse() are elsewhere in this file, and
          # for the same reason — the thing that looks like a lookup is
          # running the researcher's code. A frame whose `h` cannot be read is
          # a frame this driver cannot prove is its own, so it is KEPT: the
          # same answer ifnotfound's NULL already gives, and the safe
          # direction, since an over-trim deletes a researcher's real call
          # site while an under-trim only shows one extra line.
          handler_arg <- base::tryCatch(
            base::get0("h", envir = base::sys.frame(k), ifnotfound = NULL, inherits = FALSE),
            error = function(cond) NULL
          )
          base::identical(handler_arg, capture_stack)
        },
        TRUE
      )
      raised_calls <<- calls[!mine]
    }

    # After the parse, and before the first evaluation. This record is the
    # host's permission to signal: it holds its own signal until this arrives
    # and stops the moment the terminator does, because a turn taken is not a
    # cell entered — the turn goes true some ten to fifteen milliseconds
    # before the interpreter is anywhere near the researcher's code, and a
    # SIGINT landing in that gap is delivered to a process with nothing to
    # interrupt. A parse failure returns above and never reaches here, so a
    # cell that ran nothing is never signalled either.
    emit("run")

    if (count > 0L) {
      for (index in seq_len(count)) {
        shown <- tryCatch(
          withCallingHandlers(
            withVisible(eval(parsed[[index]], globalenv())),
            message = said,
            warning = warned,
            error = capture_stack
          ),
          error = function(cond) cond
        )
        if (inherits(shown, "condition")) {
          failure <- shown
          break
        }
        if (isTRUE(shown$visible)) {
          if (index < count) {
            # Earlier visible values autoprint, as R's own REPL does. Guarded
            # exactly as the last one's rendering is below, and for the same
            # reason: a print method is the researcher's code too, and a
            # half-written one is the ordinary state of a class in the middle
            # of a session. Unguarded here, a kernel would end over a method it
            # was only being asked to show something with — taking every
            # variable of that session's afternoon with it, and leaving the
            # cell with no answer at all rather than with a placeholder.
            tryCatch(
              print(shown$value),
              error = function(cond) cat("<a value this kernel could not render>\n")
            )
          } else {
            value <- shown$value
            has_value <- TRUE
          }
        }
      }
    }

    release()

    if (!is.null(failure)) {
      # conditionMessage() is itself an S3 generic. A custom condition class
      # carrying a raising conditionMessage.<class> method must not escape
      # here and kill the kernel over a message it was only being asked to
      # render — the same failure this file already guards for print(), one
      # rendering call away from here.
      described <- tryCatch(
        conditionMessage(failure),
        error = function(cond) "<a message this kernel could not render>"
      )
      classes <- base::class(failure)
      emit("error", paste0(classes[[1L]], "\n", described))
      trace <- frames_of(raised_calls)
      if (length(trace) > 0L) emit("trace", paste(trace, collapse = "\n"))
      terminate("fail")
      return(invisible(NULL))
    }
    if (has_value) {
      rendered <- tryCatch(
        paste(utils::capture.output(print(value)), collapse = "\n"),
        error = function(cond) "<a value this kernel could not render>"
      )
      emit("value", rendered)
    }
    terminate("ok")
    invisible(NULL)
  }

  emit("ready")
  # Two loops rather than one, and two handlers rather than one, because base
  # R gives this process no way to be deaf to a signal the way driver.py's
  # `_interruptible` makes the Python one deaf between cells. What stands in
  # for that deafness is the host, which signals only between a cell's `run`
  # record and its terminator — and what makes the slivers either side of that
  # harmless is here: wherever a signal lands, this kernel either answers the
  # cell or ends saying so, and never goes quiet with the host still waiting.
  #
  # The outer loop is what catches a signal raised anywhere the inner one's
  # own handler cannot see, and there are two such places. R checks for a
  # signal at the top of every repeat iteration, and that check belongs to the
  # loop rather than to its body. And a signal arriving while the read below
  # is blocked is not raised there at all — measured against R 4.6.1, it stays
  # pending and surfaces at the next check R makes, which may be inside the
  # read as the next cell's bytes arrive, or not until well inside that cell.
  # Going round again costs nothing at all, because both the read and the cell
  # in hand survive the trip: the read never loses a byte it has taken, and
  # `pending` still holds any cell that has not been answered.
  repeat {
    ended <- base::tryCatch(
      {
        repeat {
          # Only read when nothing is owed. A signal raised anywhere between
          # taking a cell off the stream and answering it comes back round to
          # this point, and `pending` is what says whether the cell in hand
          # has been dealt with. Reading again with one still owed would drop
          # it, and a dropped cell is the host waiting for ever on an answer
          # nothing is left to write: the wedge, reached without a single byte
          # of the stream being lost. Measured, 2 runs in 12, before `pending`
          # was carried across the loop.
          if (base::is.null(pending)) {
            source <- read_source()
            if (base::is.null(source)) break
            # `<-`, and emphatically not `<<-`. This runs at local()'s own top
            # level, where the current environment IS the closure — so `<<-`
            # would skip it, walk out to globalenv(), and write the
            # researcher's namespace instead, leaving the binding read here
            # NULL for ever and every cell arriving as an empty one. Inside
            # terminate() below, a function whose enclosure is that same
            # closure, `<<-` is the correct operator for the identical name.
            pending <- source
          }
          if (base::isTRUE(pending)) {
            # Back here with a cell that was already handed to run_cell and
            # has still not been answered — a signal escaped from somewhere
            # inside it, and the likeliest somewhere is the two statements
            # below, between an `error` record and the terminator that ends
            # it. The researcher's code may have run, in part or in whole, so
            # the one thing that must not happen now is running it again.
            # Only the terminator is owed.
            interrupted <- TRUE
          } else {
            # One handler over the whole of a cell, not over the evaluation
            # alone. R's check points are not only inside the researcher's
            # code: they are in the autoprinting of what it produced, and in
            # the rendering of the value it ended with — and rendering
            # something large is the commonest reason a person reaches for
            # Interrupt in the first place. A handler around the evaluation
            # only would leave exactly that case unanswered, which is the
            # wedge with a different cause. run_cell puts its own capture back
            # on the way out, whatever the way out was, so all that is owed
            # from here is the terminator.
            source <- pending
            pending <- TRUE
            interrupted <- base::tryCatch(
              {
                run_cell(source)
                FALSE
              },
              interrupt = function(cond) TRUE
            )
          }
          # Only when the cell has not already answered for itself: writing a
          # terminator is what clears `pending`, so a signal landing in the
          # sliver after one would otherwise put a second answer behind the
          # first, and the host — long since gone on — would read it as the
          # next cell's.
          if (interrupted && !base::is.null(pending)) {
            emit("error", "lykeionInterrupt\nthis cell was interrupted")
            terminate("fail")
          }
        }
        TRUE
      },
      interrupt = function(cond) FALSE
    )
    if (ended) break
  }
  invisible(NULL)
})
