import subprocess
import sys

from lykeion_kernel.sampler import Probe, Sample


def test_a_live_process_reports_the_memory_it_holds():
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        probe = Probe(process.pid)
        sample = probe.sample()
        assert sample.memory_bytes is not None
        assert sample.memory_bytes > 0
    finally:
        process.kill()
        process.wait()


def test_a_process_that_has_gone_reports_nothing_rather_than_zero():
    """The distinction the whole screen is built on: a kernel nobody could
    measure and a kernel measured at zero are different facts."""
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    probe = Probe(process.pid)
    sample = probe.sample()
    assert sample.memory_bytes is None
    assert sample.cpu_percent is None


def test_a_probe_of_a_pid_that_never_existed_reports_nothing():
    """Constructing a probe must not raise: a kernel can die between the
    launch that returned its pid and the first tick that reads it."""
    probe = Probe(2**22)
    assert probe.sample() == Sample()


def test_memory_counts_the_children_a_cell_forked():
    """A cell that forks workers is the case this screen exists for, and a
    figure counting only the parent reads near-zero exactly then."""
    alone = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    withkids = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import subprocess, sys, time; "
            "[subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']) "
            "for _ in range(3)]; time.sleep(30)",
        ]
    )
    try:
        import time

        time.sleep(1.5)
        one = Probe(alone.pid).sample().memory_bytes
        many = Probe(withkids.pid).sample().memory_bytes
        assert one is not None and many is not None
        assert many > one
    finally:
        for process in (alone, withkids):
            process.kill()
            process.wait()
