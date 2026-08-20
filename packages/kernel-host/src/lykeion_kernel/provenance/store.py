"""Files named by their own content, written once.

Two things follow from the naming and are worth saying once here rather than
at each call site. A destination that exists already holds exactly the bytes
being written — that is what content-addressed means — so the write is
skipped rather than repeated, and that skip is the whole of the dedup. And a
reader must never see half a file, so every write lands on a temporary name
in the destination's own directory and is then renamed, which is atomic on
one filesystem and is why two kernels racing on one hash both succeed.
"""

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .envelope import canonical_bytes

# Above this, a COPY of an output's bytes is addressed by its own hash and
# handed to the blob store; below it nothing is stored and only the hash is
# recorded. Either way the payload itself still rides the cell: nothing
# anywhere can fetch a blob back off the machine holding it, so a cell
# stripped of its bytes would be one no reader could render.
#
# 32 KiB is where text and errors fall below and plots fall above, which is
# the split that matters: a plot is the payload worth holding once under its
# own digest, and a line of stdout is not.
INLINE_MAX_BYTES = 32 * 1024


def build_fingerprint(source_id: str, lockfile_hash: str, platform: str) -> str:
    """A build's identity, keyed by its recipe rather than its result.

    The separator is load-bearing: joined without one, ("ab", "c") and
    ("a", "bc") are the same key, and a second Study would resolve a build
    that was never made for it.
    """
    joined = "\0".join((source_id, lockfile_hash, platform))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


class ProvenanceStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _path(self, kind: str, digest: str) -> Path:
        # Two-char fanout: a flat directory accumulating a file per cell per
        # Task degrades on every filesystem this runs on.
        return self.root / kind / digest[:2] / digest

    def _write_atomic(self, path: Path, data: bytes) -> None:
        # A destination that exists already holds exactly the bytes being
        # written — that is what content-addressed means — so the write is
        # skipped rather than repeated, and that skip is the whole of the
        # dedup.
        if path.exists():
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(handle, "wb") as writing:
                writing.write(data)
            # Atomic on one filesystem, and the temporary is in the
            # destination's own directory so it always is one. A loser of the
            # race replaces an identical file with an identical file.
            os.replace(temporary, path)
        except BaseException:
            # A raise here would otherwise leave a half-written temporary
            # beside the files this store promises are whole.
            Path(temporary).unlink(missing_ok=True)
            raise

    def _write_once(self, kind: str, digest: str, data: bytes) -> None:
        self._write_atomic(self._path(kind, digest), data)

    def put_envelope(self, envelope: dict[str, Any]) -> str:
        data = canonical_bytes(envelope)
        digest = hashlib.sha256(data).hexdigest()
        self._write_once("envelopes", digest, data)
        return digest

    def read_envelope(self, digest: str) -> dict[str, Any] | None:
        path = self._path("envelopes", digest)
        if not path.is_file():
            return None
        return json.loads(path.read_bytes())

    def put_blob(self, data: bytes) -> str:
        digest = hashlib.sha256(data).hexdigest()
        self._write_once("blobs", digest, data)
        return digest

    def has_blob(self, digest: str) -> bool:
        return self._path("blobs", digest).is_file()

    def record_build(self, fingerprint: str, blob_digest: str) -> None:
        path = self.root / "builds" / fingerprint
        self._write_atomic(path, canonical_bytes({"blob": blob_digest}))

    def resolve_build(self, fingerprint: str) -> str | None:
        path = self.root / "builds" / fingerprint
        if not path.is_file():
            return None
        blob = json.loads(path.read_bytes()).get("blob")
        return blob if isinstance(blob, str) else None


def _bytes_of(payload: Any) -> bytes:
    """One MIME payload as the bytes its digest is taken over.

    A payload arrives decoded from the driver's own JSON, so a `text/plain`
    or a base64 `image/png` is a string and is hashed as itself. An
    `application/json` payload is an object, and `str()` of one is this
    language's repr — single quotes, a space after every colon, `None` where
    JSON writes `null`. Hashing that would name how Python renders a value
    rather than the value, and the same repr is what would be written for a
    payload large enough to reach the store. `canonical_bytes` is the one
    rendering both ends of this contract already agree on.
    """
    if isinstance(payload, str):
        return payload.encode("utf-8")
    return canonical_bytes(payload)


def _payload_of(output: dict[str, Any]) -> list[tuple[str, bytes]]:
    """The (label, bytes) pairs an output is hashed over.

    A stream and an error each hash over the one thing they carry; a
    `display_data` or `execute_result` hashes each MIME payload separately,
    because a reader asking for one of them should not have to fetch the
    others to check it.
    """
    kind = output.get("kind")
    if kind == "stream":
        return [(str(output.get("name", "")), str(output.get("text", "")).encode("utf-8"))]
    if kind == "error":
        traceback = "\n".join(output.get("traceback", []))
        return [(str(output.get("ename", "")), traceback.encode("utf-8"))]
    data = output.get("data")
    if isinstance(data, dict):
        return [(str(mime), _bytes_of(payload)) for mime, payload in data.items()]
    return []


def stage_output_hashes(
    outputs: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, bytes]]:
    """Hash every output and rewrite its `data_ref` in place, touching no store.

    The digest and the size-based decision of whether a payload is copied to
    the store are both pure functions of the bytes a cell produced, so both
    can be had by a caller that must not let a disk write sit inside a lock
    it is holding — the kernel host's per-kernel turn is that caller. What is
    above the ceiling comes back keyed by its own digest rather than written
    anywhere, for whoever called this outside the lock to hand to
    `ProvenanceStore.put_blob`.

    The outputs themselves are left holding their payloads. What is staged is
    a second copy of the bytes, not a substitute for them.

    `data_ref` is written here and nowhere else. A `stream` and an `error`
    have no `data_ref` in their shape and get none — `data_ref` describes
    the payloads an output carries under a MIME type.
    """
    items: list[dict[str, Any]] = []
    blobs: dict[str, bytes] = {}
    for output in outputs:
        references: dict[str, Any] = {}
        for label, data in _payload_of(output):
            digest = hashlib.sha256(data).hexdigest()
            stored = len(data) > INLINE_MAX_BYTES
            if stored:
                blobs[digest] = data
            items.append(
                {
                    "kind": str(output.get("kind", "")),
                    "label": label,
                    "sha256": digest,
                    "size": len(data),
                    "stored": stored,
                }
            )
            references[label] = {"sha256": digest, "size": len(data), "stored": stored}
        if "data_ref" in output:
            output["data_ref"] = references
    return items, blobs


def hash_outputs(outputs: list[dict[str, Any]], store: ProvenanceStore) -> list[dict[str, Any]]:
    """Hash every output, and copy the ones above the ceiling into the store.

    The hash goes on every output whether or not a copy was kept: it is the
    key a later reader joins on, and an output that skipped it because it
    happened to be small would be a hole in that join.

    Runs the staging in `stage_output_hashes` and then writes what it staged.
    A caller that must not hold a store write inside a lock uses that
    function directly instead of this one — see its docstring.
    """
    items, blobs = stage_output_hashes(outputs)
    for data in blobs.values():
        store.put_blob(data)
    return items
