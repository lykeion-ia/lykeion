import { describe, expect, it } from "vitest";
import {
  ENVELOPE_VERSION,
  canonicalJson,
  envelopeHash,
  type ProvenanceEnvelope,
} from "./provenance.js";
import { createHash } from "node:crypto";

describe("canonicalJson", () => {
  it("sorts keys and drops insignificant space", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ o: { z: 1, y: 2 } })).toBe('{"o":{"y":2,"z":1}}');
  });

  it("leaves non-ASCII unescaped", () => {
    expect(canonicalJson({ k: "é" })).toBe('{"k":"é"}');
  });

  it("preserves array order", () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("omits an absent optional rather than writing null", () => {
    // The absent-key rule reaches the hash: a key written as null and a key
    // left out are two different envelopes with two different identities,
    // and only one of them is what the writer meant.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("envelopeHash", () => {
  it("is the sha256 of those bytes", () => {
    const expected = createHash("sha256").update('{"a":2,"b":1}', "utf8").digest("hex");
    expect(envelopeHash({ b: 1, a: 2 } as never)).toBe(expected);
  });

  it("ignores the key order of its input", () => {
    expect(envelopeHash({ a: 1, b: 2 } as never)).toBe(envelopeHash({ b: 2, a: 1 } as never));
  });
});

describe("ENVELOPE_VERSION", () => {
  it("is v1", () => {
    expect(ENVELOPE_VERSION).toBe("lykeion.provenance.v1");
  });
});

describe("canonical bytes conformance vector", () => {
  it("matches the vector the contract pins", () => {
    // One envelope, one byte string, both languages. The Python side
    // asserts the same literal against its own `canonical_bytes`. Neither
    // side can drift without the other's copy of this vector failing,
    // which is the only thing standing between a key-order difference and
    // a store that silently stops deduplicating.
    const envelope: ProvenanceEnvelope = {
      version: "lykeion.provenance.v1",
      identity: {
        studyId: "st_1",
        taskId: "tk_1",
        sessionId: "se_1",
        kernelId: "k_1",
        cellId: "cell_1",
      },
      input: {
        code: "x = 1\n",
        cwd: "/w",
        codeState: {
          lineage: { incarnation: 0, index: 0, digest: "d0" },
          git: { status: "unavailable", reason: "not_applicable" },
        },
      },
      environment: {
        host: {
          platform: "darwin",
          arch: "arm64",
          runtimes: { status: "unavailable", reason: "not_captured" },
        },
        kernel: {
          id: "k_1",
          language: "python",
          incarnation: 0,
          processId: 2,
          processStartedAt: 100,
        },
      },
      outputs: { status: "succeeded", items: [] },
      timestamps: { createdAt: 100, startedAt: 101, completedAt: 102 },
    };

    expect(canonicalJson(envelope)).toBe(
      '{"environment":{"host":{"arch":"arm64","platform":"darwin",' +
        '"runtimes":{"reason":"not_captured","status":"unavailable"}},' +
        '"kernel":{"id":"k_1","incarnation":0,"language":"python",' +
        '"processId":2,"processStartedAt":100}},' +
        '"identity":{"cellId":"cell_1","kernelId":"k_1","sessionId":"se_1",' +
        '"studyId":"st_1","taskId":"tk_1"},' +
        '"input":{"code":"x = 1\\n","codeState":{"git":{"reason":"not_applicable",' +
        '"status":"unavailable"},"lineage":{"digest":"d0","incarnation":0,"index":0}},' +
        '"cwd":"/w"},' +
        '"outputs":{"items":[],"status":"succeeded"},' +
        '"timestamps":{"completedAt":102,"createdAt":100,"startedAt":101},' +
        '"version":"lykeion.provenance.v1"}',
    );
  });
});
