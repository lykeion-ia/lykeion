"""Whether the daemon and this host agree on the wire, checked from the
host's side: `serve()` driven with the literal bytes the daemon's writer
produces, rather than with a hand-formatted stand-in for them.

A TypeScript suite that talks only to a stub host, and a Python suite that
talks only to a stub daemon, can both be green while the real pair cannot
exchange a single message — a field renamed on one side and forgotten on
the other passes each suite alone. This file is what would not: every
assertion below hardcodes the exact object the daemon's `call()` serializes,
so a reply keyed under anything but `id` / `result` / `error.message` fails
here, not just in whatever eventually tries to talk to a real host.
"""

import io
import json
import sys
from pathlib import Path

from lykeion_kernel.host import serve
from lykeion_kernel.kernels.python import DRIVER
from lykeion_kernel.registry import Registry


def test_answers_the_bytes_the_daemon_actually_sends():
    # The exact line the daemon's writer produces for its first call.
    stdin = io.StringIO('{"id": 1, "method": "host.hello", "params": {}}\n')
    stdout = io.StringIO()
    serve(stdin, stdout)
    reply = json.loads(stdout.getvalue().strip())
    assert reply["id"] == 1
    assert reply["result"]["protocol"] == 5


def test_answers_the_compact_bytes_the_daemon_writes_with_no_spaces():
    # `JSON.stringify({ id, method, params })` inserts no space after `:`
    # or `,`. This is that literal string, not an approximation of it.
    stdin = io.StringIO('{"id":2,"method":"host.hello","params":{}}\n')
    stdout = io.StringIO()
    serve(stdin, stdout)
    reply = json.loads(stdout.getvalue().strip())
    assert reply["id"] == 2
    assert reply["result"]["protocol"] == 5


def test_the_greeting_names_one_descriptor_per_language_this_machine_runs():
    holding = Registry(["/usr/bin/env"])
    stdin = io.StringIO('{"id":4,"method":"host.hello","params":{}}\n')
    stdout = io.StringIO()
    serve(stdin, stdout, holding)
    result = json.loads(stdout.getvalue())["result"]
    assert result["protocol"] == 5
    python = next(d for d in result["languages"] if d["language"] == "python")
    assert python["environment"] == "python"
    assert python["interpreter"] == sys.executable
    assert str(Path(DRIVER).parent) in python["reads"]
    # The singulars are gone rather than kept alongside. A field nothing
    # renders is one the next reader has to work out is dead.
    assert "environment" not in result
    assert "reads" not in result
    assert "interpreter" not in result


def test_a_failed_call_comes_back_shaped_the_way_the_daemon_reads_one():
    # The daemon settles a call by reading `error.message` off a reply
    # carrying the request's own id. A host answering under any other key
    # would leave that call's promise resolved with `undefined` instead of
    # rejected, which reads as success to whatever asked.
    stdin = io.StringIO('{"id":3,"method":"host.nonsense","params":{}}\n')
    stdout = io.StringIO()
    serve(stdin, stdout)
    reply = json.loads(stdout.getvalue().strip())
    assert reply["id"] == 3
    assert isinstance(reply["error"]["message"], str)


def test_canonical_bytes_match_the_vector_the_contract_pins() -> None:
    """One envelope, one byte string, both languages.

    The TypeScript side asserts the same literal against its own
    `canonicalJson`. Neither side can drift without the other's copy of this
    vector failing, which is the only thing standing between a key-order
    difference and a store that silently stops deduplicating.
    """
    from lykeion_kernel.provenance.envelope import canonical_bytes

    envelope = {
        "version": "lykeion.provenance.v1",
        "identity": {
            "studyId": "st_1",
            "taskId": "tk_1",
            "sessionId": "se_1",
            "kernelId": "k_1",
            "cellId": "cell_1",
        },
        "input": {
            "code": "x = 1\n",
            "cwd": "/w",
            "codeState": {
                "lineage": {"incarnation": 0, "index": 0, "digest": "d0"},
                "git": {"status": "unavailable", "reason": "not_applicable"},
            },
        },
        "environment": {
            "host": {
                "platform": "darwin",
                "arch": "arm64",
                "runtimes": {"status": "unavailable", "reason": "not_captured"},
            },
            "kernel": {
                "id": "k_1",
                "language": "python",
                "incarnation": 0,
                "processId": 2,
                "processStartedAt": 100,
            },
        },
        "outputs": {"status": "succeeded", "items": []},
        "timestamps": {"createdAt": 100, "startedAt": 101, "completedAt": 102},
    }

    assert canonical_bytes(envelope) == (
        b'{"environment":{"host":{"arch":"arm64","platform":"darwin",'
        b'"runtimes":{"reason":"not_captured","status":"unavailable"}},'
        b'"kernel":{"id":"k_1","incarnation":0,"language":"python",'
        b'"processId":2,"processStartedAt":100}},'
        b'"identity":{"cellId":"cell_1","kernelId":"k_1","sessionId":"se_1",'
        b'"studyId":"st_1","taskId":"tk_1"},'
        b'"input":{"code":"x = 1\\n","codeState":{"git":{"reason":"not_applicable",'
        b'"status":"unavailable"},"lineage":{"digest":"d0","incarnation":0,"index":0}},'
        b'"cwd":"/w"},'
        b'"outputs":{"items":[],"status":"succeeded"},'
        b'"timestamps":{"completedAt":102,"createdAt":100,"startedAt":101},'
        b'"version":"lykeion.provenance.v1"}'
    )
