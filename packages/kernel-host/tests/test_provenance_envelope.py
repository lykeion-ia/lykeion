"""The envelope's shape, its bytes, and the hash those bytes produce."""

import json

from lykeion_kernel.provenance.envelope import (
    ENVELOPE_VERSION,
    canonical_bytes,
    envelope_hash,
)


def test_canonical_bytes_sort_keys_and_drop_insignificant_space() -> None:
    assert canonical_bytes({"b": 1, "a": 2}) == b'{"a":2,"b":1}'


def test_canonical_bytes_sort_nested_keys_too() -> None:
    assert canonical_bytes({"o": {"z": 1, "y": 2}}) == b'{"o":{"y":2,"z":1}}'


def test_canonical_bytes_leave_non_ascii_unescaped() -> None:
    # The join point with JSON.stringify, which emits these raw. Escaping
    # them here would give the same envelope two different hashes depending
    # on which side of the wire built it.
    assert canonical_bytes({"k": "é"}) == '{"k":"é"}'.encode()


def test_canonical_bytes_preserve_array_order() -> None:
    assert canonical_bytes({"a": [3, 1, 2]}) == b'{"a":[3,1,2]}'


def test_envelope_hash_is_the_sha256_of_those_bytes() -> None:
    import hashlib

    obj = {"b": 1, "a": 2}
    assert envelope_hash(obj) == hashlib.sha256(b'{"a":2,"b":1}').hexdigest()


def test_version_is_v1() -> None:
    assert ENVELOPE_VERSION == "lykeion.provenance.v1"


def test_hash_ignores_key_order_of_the_input() -> None:
    assert envelope_hash({"a": 1, "b": 2}) == envelope_hash({"b": 2, "a": 1})


def test_canonical_bytes_round_trip_to_the_same_object() -> None:
    obj = {"a": 1, "n": {"x": [1, {"q": True}]}, "s": "t"}
    assert json.loads(canonical_bytes(obj)) == obj
