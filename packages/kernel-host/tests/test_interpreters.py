"""What this machine says it can run."""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from lykeion_kernel import interpreters
from lykeion_kernel.interpreters import runnables
from lykeion_kernel.kernels.python import DRIVER


def _standing_in_for_rscript(tmp_path, monkeypatch, script: str):
    """An Rscript on this machine's PATH that behaves however a test needs.

    Planted on PATH rather than patched into `shutil.which`, so what is being
    exercised is the resolution this code actually does. PATH is replaced
    outright rather than prepended to, which is what keeps a machine that has
    a real R from answering the question instead of this one.
    """
    pretending = tmp_path / "Rscript"
    pretending.write_text(script)
    pretending.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    return pretending


def _python(interpreter: str | None = None):
    found = runnables() if interpreter is None else runnables(interpreter)
    return next(runnable for runnable in found if runnable.language == "python")


def test_this_machine_always_runs_python():
    assert "python" in [runnable.language for runnable in runnables()]


def test_pythons_reads_name_every_place_a_kernel_must_open_to_start():
    python = _python()
    assert python.environment == "python"
    for named in (sys.executable, sys.prefix, sys.base_prefix, str(Path(DRIVER).parent)):
        assert named in python.reads


def test_the_interpreter_reported_is_the_one_it_was_asked_about():
    # The registry may hold an interpreter that is not this process's own, and
    # a boundary rendered for the wrong one refuses the kernel before its
    # first instruction.
    python = _python("/opt/weird/python")
    assert python.interpreter == "/opt/weird/python"
    assert python.reads[0] == "/opt/weird/python"


def test_a_place_named_twice_is_carried_once_and_keeps_its_place():
    # sys.prefix and sys.base_prefix are the same path outside a virtualenv,
    # and a boundary rendered from a list holding one path twice is a rule
    # written twice. The interpreter stays first: the others are what it is
    # built out of.
    python = _python()
    assert list(python.reads) == list(dict.fromkeys(python.reads))


def test_r_is_reported_only_where_this_machine_has_it():
    languages = [runnable.language for runnable in runnables()]
    assert ("r" in languages) == (shutil.which("Rscript") is not None)


def test_an_r_that_never_answers_does_not_take_the_whole_host_with_it(
    tmp_path, monkeypatch, capsys
):
    # Where this runs is the whole reason it is bounded. `_r()` is called from
    # Registry.__init__, which serve() calls BEFORE the loop that reads the
    # daemon's messages — so an Rscript that never returns is not a slow
    # answer about R, it is a host that never answers anything: no host.hello,
    # the daemon's reach deadline expires, and every Task opened on this
    # machine comes up with no kernels at all, Python ones included. The host
    # is never restarted, by design, so that lasts as long as the machine is
    # up. `.libPaths()` on an unreachable mount is the ordinary way there.
    #
    # The deadline is shortened rather than waited out: what is being asserted
    # is that there IS one, and a test that took ten real seconds to say so
    # would be paid for on every run by everyone.
    #
    # `/bin/sleep` by its full path, and that is not fussiness. PATH is
    # replaced outright above so that no real R answers this, which also means
    # the shell running this script can look nothing up — written `sleep 60`
    # it exits 127 instantly and the test measures an R that FAILED rather
    # than one that hung, which is a different finding wearing this one's
    # name. Caught by inverting this very test: with the timeout taken out it
    # still failed, but on the wrong assertion.
    hanging = _standing_in_for_rscript(tmp_path, monkeypatch, "#!/bin/sh\nexec /bin/sleep 60\n")
    monkeypatch.setattr(interpreters, "R_ASK_S", 0.5)

    began = time.monotonic()
    found = runnables()
    spent = time.monotonic() - began

    assert spent < 30, "this host waited on an R that was never going to answer"
    assert [runnable.language for runnable in found] == ["python"]
    # And Python is still reported, which is the half that matters most: a
    # machine whose R hangs still runs the language the host is written in.
    said = capsys.readouterr().err
    assert str(hanging) in said
    assert "did not answer" in said


def test_an_r_that_is_broken_says_so_rather_than_looking_like_an_r_that_is_absent(
    tmp_path, monkeypatch, capsys
):
    # Two facts arrive above here as the identical empty list of languages,
    # and a researcher meets both as the same missing chip. The only place
    # they can be told apart is this line, on the stream the daemon keeps a
    # tail of — so what R itself said is carried into it rather than dropped.
    _standing_in_for_rscript(
        tmp_path, monkeypatch, "#!/bin/sh\necho 'error: unable to load libRblas' >&2\nexit 1\n"
    )

    assert [runnable.language for runnable in runnables()] == ["python"]
    said = capsys.readouterr().err
    assert "unable to load libRblas" in said
    assert "exited 1" in said


def test_a_machine_with_no_r_on_it_says_nothing_at_all(tmp_path, monkeypatch, capsys):
    # The absence that is not a fault. An operator reading this stream must be
    # able to take a line on it as meaning something is wrong, which it cannot
    # if every machine without R writes one.
    monkeypatch.setenv("PATH", str(tmp_path))
    assert [runnable.language for runnable in runnables()] == ["python"]
    assert capsys.readouterr().err == ""


@pytest.mark.integration
def test_rs_reads_are_asked_of_r_itself_and_include_its_library_paths():
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("this machine has no Rscript, so it holds no R kernels")
    r = next(runnable for runnable in runnables() if runnable.language == "r")
    assert r.environment == "r"
    assert r.interpreter == rscript
    # R.home() alone would deny every package a researcher ever installed:
    # on a homebrew install the site-library sits outside it. Asked of R again
    # here rather than derived, and named rather than counted: a resolver that
    # kept R.home() and dropped the libraries still answers with three paths,
    # so a count alone would go green on the very boundary this is about.
    asked = subprocess.run(
        [rscript, "--vanilla", "-e", "cat(.libPaths(), sep='\\n')"],
        capture_output=True,
        text=True,
        check=True,
    )
    libraries = [line for line in asked.stdout.splitlines() if line]
    assert libraries, "this machine's R named no library paths at all"
    for library in libraries:
        assert library in r.reads
    assert len(r.reads) > 2
