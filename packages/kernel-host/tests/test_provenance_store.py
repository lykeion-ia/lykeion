"""The store: write-once, addressed by content, safe to race on."""

import hashlib
import threading
from pathlib import Path

import pytest

from lykeion_kernel.provenance.envelope import canonical_bytes
from lykeion_kernel.provenance.store import (
    INLINE_MAX_BYTES,
    ProvenanceStore,
    build_fingerprint,
    hash_outputs,
    stage_output_hashes,
)


@pytest.fixture
def store(tmp_path: Path) -> ProvenanceStore:
    return ProvenanceStore(tmp_path / "provenance")


def test_put_envelope_returns_its_hash(store: ProvenanceStore) -> None:
    assert store.put_envelope({"a": 1}) == hashlib.sha256(b'{"a":1}').hexdigest()


def test_put_envelope_writes_under_a_two_char_fanout(store: ProvenanceStore) -> None:
    digest = store.put_envelope({"a": 1})
    assert (store.root / "envelopes" / digest[:2] / digest).is_file()


def test_an_envelope_reads_back_as_what_went_in(store: ProvenanceStore) -> None:
    digest = store.put_envelope({"a": 1, "b": {"c": 2}})
    assert store.read_envelope(digest) == {"a": 1, "b": {"c": 2}}


def test_reading_an_absent_envelope_is_none_rather_than_a_raise(store: ProvenanceStore) -> None:
    assert store.read_envelope("0" * 64) is None


def test_writing_the_same_envelope_twice_is_a_no_op(store: ProvenanceStore) -> None:
    first = store.put_envelope({"a": 1})
    path = store.root / "envelopes" / first[:2] / first
    written_at = path.stat().st_mtime_ns
    assert store.put_envelope({"a": 1}) == first
    # The dedup is the existence check, not a rewrite that happens to
    # produce the same bytes: a store that rewrote would touch the file.
    assert path.stat().st_mtime_ns == written_at


def test_a_blob_is_addressed_by_its_own_bytes(store: ProvenanceStore) -> None:
    digest = store.put_blob(b"hello")
    assert digest == hashlib.sha256(b"hello").hexdigest()
    assert (store.root / "blobs" / digest[:2] / digest).read_bytes() == b"hello"


def test_has_blob_answers_before_and_after(store: ProvenanceStore) -> None:
    digest = hashlib.sha256(b"x").hexdigest()
    assert store.has_blob(digest) is False
    store.put_blob(b"x")
    assert store.has_blob(digest) is True


def test_concurrent_writers_of_one_blob_all_succeed(store: ProvenanceStore) -> None:
    # Two kernels finishing the same output at once is ordinary, and neither
    # is owed an error for having been second.
    seen: list[str] = []
    errors: list[BaseException] = []

    def write() -> None:
        try:
            seen.append(store.put_blob(b"same"))
        except BaseException as raised:  # noqa: BLE001 - recorded, then asserted
            errors.append(raised)

    threads = [threading.Thread(target=write) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert set(seen) == {hashlib.sha256(b"same").hexdigest()}


def test_no_temp_file_survives_a_write(store: ProvenanceStore) -> None:
    store.put_blob(b"x")
    leftovers = [p for p in (store.root / "blobs").rglob("*") if p.is_file() and len(p.name) != 64]
    assert leftovers == []


def test_a_build_resolves_to_the_blob_it_recorded(store: ProvenanceStore) -> None:
    fingerprint = build_fingerprint("src@1", "lock-abc", "darwin-arm64")
    assert store.resolve_build(fingerprint) is None
    store.record_build(fingerprint, "deadbeef")
    assert store.resolve_build(fingerprint) == "deadbeef"


def test_recording_the_same_build_twice_is_a_no_op(store: ProvenanceStore) -> None:
    fingerprint = build_fingerprint("src@1", "lock-abc", "darwin-arm64")
    store.record_build(fingerprint, "deadbeef")
    path = store.root / "builds" / fingerprint
    written_at = path.stat().st_mtime_ns
    store.record_build(fingerprint, "deadbeef")
    assert path.stat().st_mtime_ns == written_at
    assert store.resolve_build(fingerprint) == "deadbeef"


def test_a_fingerprint_is_stable_and_separates_its_three_inputs() -> None:
    assert build_fingerprint("s", "l", "p") == build_fingerprint("s", "l", "p")
    # Without a separator, ("ab","c") and ("a","bc") would be one key, and a
    # second Study would resolve a build that was never made for it.
    assert build_fingerprint("ab", "c", "p") != build_fingerprint("a", "bc", "p")


def test_the_inline_ceiling_is_32_kib() -> None:
    assert INLINE_MAX_BYTES == 32 * 1024


def test_a_small_output_stays_inline_and_is_still_hashed(store: ProvenanceStore) -> None:
    outputs = [{"kind": "execute_result", "execution_count": 1, "data": {"text/plain": "4"}, "data_ref": {}}]
    items = hash_outputs(outputs, store)

    assert items[0]["stored"] is False
    assert items[0]["sha256"] == hashlib.sha256(b"4").hexdigest()
    # The hash is the join key, so it is on `data_ref` whether or not the
    # bytes went anywhere.
    assert outputs[0]["data_ref"]["text/plain"]["stored"] is False
    assert store.has_blob(items[0]["sha256"]) is False


def test_a_large_output_goes_to_the_store(store: ProvenanceStore) -> None:
    big = "x" * (INLINE_MAX_BYTES + 1)
    outputs = [{"kind": "display_data", "data": {"image/png": big}, "data_ref": {}, "metadata": None}]
    items = hash_outputs(outputs, store)

    assert items[0]["stored"] is True
    assert store.has_blob(items[0]["sha256"]) is True
    assert outputs[0]["data_ref"]["image/png"] == {
        "sha256": items[0]["sha256"],
        "size": len(big.encode()),
        "stored": True,
    }


def test_a_stream_is_hashed_over_its_text(store: ProvenanceStore) -> None:
    outputs = [{"kind": "stream", "name": "stdout", "text": "hi\n"}]
    items = hash_outputs(outputs, store)
    assert items[0]["kind"] == "stream"
    assert items[0]["label"] == "stdout"
    assert items[0]["sha256"] == hashlib.sha256(b"hi\n").hexdigest()


def test_an_error_is_an_item_too(store: ProvenanceStore) -> None:
    # A failed cell has outputs, and a record that skipped them would be a
    # record of the runs that went well.
    outputs = [{"kind": "error", "ename": "ValueError", "evalue": "x", "traceback": ["a", "b"]}]
    items = hash_outputs(outputs, store)
    assert items[0]["kind"] == "error"
    assert items[0]["label"] == "ValueError"


def test_two_outputs_with_the_same_bytes_are_stored_once(store: ProvenanceStore) -> None:
    big = "y" * (INLINE_MAX_BYTES + 1)
    first = [{"kind": "display_data", "data": {"image/png": big}, "data_ref": {}, "metadata": None}]
    second = [{"kind": "display_data", "data": {"image/png": big}, "data_ref": {}, "metadata": None}]
    assert hash_outputs(first, store)[0]["sha256"] == hash_outputs(second, store)[0]["sha256"]


def test_an_output_of_exactly_the_ceiling_stays_inline(store: ProvenanceStore) -> None:
    # The ceiling names the maximum size still eligible for inline, and the
    # large-output test above spills at one byte past it rather than at it —
    # if the boundary value itself were meant to spill, that test would have
    # used it directly rather than `INLINE_MAX_BYTES + 1`.
    exact = "z" * INLINE_MAX_BYTES
    outputs = [{"kind": "execute_result", "execution_count": 1, "data": {"text/plain": exact}, "data_ref": {}}]
    items = hash_outputs(outputs, store)
    assert items[0]["stored"] is False


def test_a_structured_payload_is_hashed_over_its_canonical_bytes(store: ProvenanceStore) -> None:
    # An `application/json` payload arrives as a Python object, and `str()` of
    # one is this language's own repr — single quotes, a space after every
    # colon, `None` where JSON writes `null`. A hash over that names how
    # Python happens to render a value rather than the value itself, and the
    # hash is what a reader joins on.
    outputs = [
        {
            "kind": "display_data",
            "data": {"application/json": {"b": 2, "a": [1, None]}},
            "data_ref": {},
            "metadata": None,
        }
    ]
    items = hash_outputs(outputs, store)

    canonical = b'{"a":[1,null],"b":2}'
    assert items[0]["sha256"] == hashlib.sha256(canonical).hexdigest()
    assert items[0]["size"] == len(canonical)
    assert outputs[0]["data_ref"]["application/json"]["sha256"] == items[0]["sha256"]


def test_a_large_structured_payload_is_stored_as_those_same_bytes() -> None:
    # The digest names the blob, so the blob has to BE what the digest was
    # taken over. A repr hashed and a repr written agree with each other and
    # with nothing else.
    payload = {"rows": ["q" * 64] * 1024}
    outputs = [
        {
            "kind": "display_data",
            "data": {"application/json": payload},
            "data_ref": {},
            "metadata": None,
        }
    ]
    items, blobs = stage_output_hashes(outputs)

    assert items[0]["stored"] is True
    assert blobs[items[0]["sha256"]] == canonical_bytes(payload)


def test_staging_a_large_output_never_calls_the_store(monkeypatch: pytest.MonkeyPatch) -> None:
    # `stage_output_hashes` is what runs inside the kernel's turn, where a
    # disk write must not happen. Patched on the class rather than checked
    # against one instance, so this catches a write through ANY store a
    # future edit might reach for — not only one this test happens to hold a
    # reference to. `hash_outputs`'s own tests write immediately after
    # staging, so a `put_blob` added inside staging itself would be a silent
    # no-op there, landing on the same digest a moment early.
    calls: list[bytes] = []
    monkeypatch.setattr(ProvenanceStore, "put_blob", lambda self, data: calls.append(data))

    big = "w" * (INLINE_MAX_BYTES + 1)
    outputs = [{"kind": "display_data", "data": {"image/png": big}, "data_ref": {}, "metadata": None}]
    items, blobs = stage_output_hashes(outputs)

    assert calls == []
    assert items[0]["stored"] is True
    assert blobs[items[0]["sha256"]] == big.encode()
