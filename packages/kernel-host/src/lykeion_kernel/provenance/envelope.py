"""One envelope, and the bytes its identity is computed over.

The identity is the hash of the bytes, so the bytes have to be reproducible
across both languages that build them. Sorted keys, no insignificant space,
UTF-8, and non-ASCII left alone — the last because `JSON.stringify` emits it
raw, and a Python side that escaped it would give the same envelope two
identities depending on which process happened to write it.
"""

import hashlib
import json
from typing import Any

ENVELOPE_VERSION = "lykeion.provenance.v1"


def canonical_bytes(obj: Any) -> bytes:
    """These bytes, for an envelope or for any JSON value inside one.

    Widened past the envelope itself because an output's MIME payload is
    hashed the same way and can be an object, an array, or a bare scalar —
    one rendering, so a payload's digest and the envelope carrying it are
    computed over bytes produced the same way in both languages.
    """
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def envelope_hash(obj: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_bytes(obj)).hexdigest()


def lineage_seed(kernel_id: str, incarnation: int) -> str:
    """Where one incarnation's chain begins.

    Keyed on the incarnation as well as the kernel because a restart wipes
    the namespace: two incarnations sharing a seed would be the chain
    asserting continuity across the one event that breaks it.
    """
    return hashlib.sha256(f"{kernel_id}\0{incarnation}".encode("utf-8")).hexdigest()


def lineage_next(previous_digest: str, provenance_id: str) -> str:
    """One link. Order is content here: a namespace built by the same cells
    in a different order is a different namespace."""
    return hashlib.sha256(f"{previous_digest}\0{provenance_id}".encode("utf-8")).hexdigest()
