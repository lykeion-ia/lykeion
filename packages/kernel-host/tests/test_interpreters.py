"""What this machine says it can run."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

from lykeion_kernel.interpreters import _r, runnables
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


def test_bare_rscript_no_longer_manufactures_an_environment(tmp_path, monkeypatch):
    """A machine having R is not a lab having declared one.

    `r` is a declaration now. A discovered interpreter answering to that name
    would let a cell run in an unpinned R that no colleague can reproduce —
    which is the whole failure this subsystem exists to prevent (D-R2).

    A real, WORKING executable is planted on PATH — via `_standing_in_for_
    rscript`, not a monkeypatched `shutil.which` returning a path that does
    not exist. A nonexistent path discriminates nothing: pre-fix `_r()` would
    have hit `subprocess.run`'s `OSError` branch and returned `None` too, for
    a reason that has nothing to do with discovery being removed. A real
    script that actually runs is what pre-fix `_r()` would have resolved,
    executed, and built a genuine `Runnable` from.
    """
    _standing_in_for_rscript(tmp_path, monkeypatch, "#!/bin/sh\necho /fake/r-home\n")
    assert _r() is None


def test_r_is_never_reported_regardless_of_what_this_machine_has(tmp_path, monkeypatch):
    """The old contract varied with the machine: `"r" in languages` tracked
    `shutil.which("Rscript") is not None`. The new one does not vary at all —
    proven with a real, WORKING Rscript planted on PATH, the one case the old
    test could not tell apart from genuine discovery succeeding.
    """
    _standing_in_for_rscript(tmp_path, monkeypatch, "#!/bin/sh\necho ok\n")
    assert "r" not in [runnable.language for runnable in runnables()]


def test_an_r_that_would_have_hung_no_longer_can_because_nothing_asks_it_anything(
    tmp_path, monkeypatch, capsys
):
    # The old bound on this was a timeout: Registry.__init__ calls this before
    # serve()'s own loop starts reading the daemon, so a wedged subprocess
    # call here used to cost the whole host its first answer, not merely R's.
    # The new bound is stronger — there is no subprocess call left to wedge.
    # `/bin/sleep`, by its full path, would still hang a shell that ran it;
    # the point is that nothing here runs it at all.
    _standing_in_for_rscript(tmp_path, monkeypatch, "#!/bin/sh\nexec /bin/sleep 60\n")

    began = time.monotonic()
    found = runnables()
    spent = time.monotonic() - began

    assert spent < 1, "this host asked a process it no longer has any reason to ask"
    assert [runnable.language for runnable in found] == ["python"]
    # Nothing was inspected, so nothing was said about it — contrast the old
    # behaviour just below, which spoke about R specifically because it had
    # gone and looked.
    assert capsys.readouterr().err == ""


def test_an_r_that_is_broken_is_never_distinguished_from_one_that_is_absent(
    tmp_path, monkeypatch, capsys
):
    # The old contract kept "broken" and "absent" apart on stderr, because
    # `_r()` had gone and asked R something and could report what it said.
    # Nothing here asks R anything any more, so the two collapse to the same
    # silent outcome — there is no finding left to distinguish.
    _standing_in_for_rscript(
        tmp_path, monkeypatch, "#!/bin/sh\necho 'error: unable to load libRblas' >&2\nexit 1\n"
    )

    assert [runnable.language for runnable in runnables()] == ["python"]
    assert capsys.readouterr().err == ""


def test_a_machine_with_no_r_on_it_says_nothing_at_all(tmp_path, monkeypatch, capsys):
    # The absence that was never a fault, and still is not: silence here
    # means nothing was discovered, which is now true of every machine.
    monkeypatch.setenv("PATH", str(tmp_path))
    assert [runnable.language for runnable in runnables()] == ["python"]
    assert capsys.readouterr().err == ""


@pytest.mark.integration
def test_a_real_machines_r_is_still_never_reported():
    # The strongest case left to make, run against whatever is actually
    # installed on the machine running this suite rather than a stand-in: a
    # genuine, healthy, real Rscript — R.home(), library paths and all — is
    # still absent from what `runnables()` reports. Discovery is gone, not
    # merely unreliable; a real interpreter proves that as well as a fake one
    # does, and this is the one test in the file that can reach for a real
    # one at all.
    assert "r" not in [runnable.language for runnable in runnables()]
