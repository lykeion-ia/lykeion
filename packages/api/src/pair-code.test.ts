import { describe, expect, it } from "vitest";
import { decodeRequest, encodeRequest, type PairRequest } from "./pair-code";

const fields: PairRequest = {
  name: "gpu-box",
  platform: "linux-x64",
  version: "0.1.0",
  challenge: "abc",
  state: "def",
  redirect: "http://127.0.0.1:1421/paired",
};

it("carries exactly the fields the redirect carries", () => {
  expect(decodeRequest(encodeRequest(fields))).toEqual(fields);
});

it("names its own version, so the shape can change later without guessing", () => {
  expect(encodeRequest(fields).startsWith("LYK1.")).toBe(true);
});

it("refuses a blob from a version it does not know", () => {
  expect(decodeRequest("LYK9.abcdef")).toBeUndefined();
});

it("refuses something that is not a blob at all", () => {
  expect(decodeRequest("hello")).toBeUndefined();
  expect(decodeRequest("LYK1.not-base64!!")).toBeUndefined();
});

it("survives the line breaks a terminal puts in it", () => {
  // The blob is printed by a daemon into a terminal and selected with a
  // mouse. Terminals wrap, selections pick up the wrap, and the researcher
  // has no way to tell which whitespace was theirs and which was the
  // window's. Whitespace is never base64url, so stripping it cannot lose a
  // character that was part of the request.
  const blob = encodeRequest(fields);
  const wrapped = `  ${blob.slice(0, 20)}\n${blob.slice(20, 60)}\n  ${blob.slice(60)}  `;
  expect(decodeRequest(wrapped)).toEqual(fields);
});

it("refuses a request that is missing a field, rather than one with a hole in it", () => {
  // Every field is load-bearing: without a redirect there is nowhere to send
  // the code, without a challenge there is nothing to redeem, and without a
  // state the daemon cannot tell its own answer from somebody else's. A
  // partial request that decoded would reach the approval screen and fail
  // there, naming the machine as if the fault were the lab's.
  for (const missing of Object.keys(fields) as (keyof PairRequest)[]) {
    const partial = { ...fields };
    delete partial[missing];
    expect(decodeRequest(encodeRequest(partial as PairRequest))).toBeUndefined();
  }
});

it("refuses a blob that decodes to something other than a request", () => {
  const asBlob = (value: unknown) =>
    `LYK1.${btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  expect(decodeRequest(asBlob([1, 2, 3]))).toBeUndefined();
  expect(decodeRequest(asBlob("a string"))).toBeUndefined();
  expect(decodeRequest(asBlob(null))).toBeUndefined();
  expect(decodeRequest(asBlob({ n: 1, p: 2, v: 3, c: 4, s: 5, r: 6 }))).toBeUndefined();
});

describe("what the blob is and is not", () => {
  it("is not a secret, and is written so nobody has to take that on faith", () => {
    // The point of the round trip: anybody holding the blob can read every
    // field in it. It is safe to print, safe to paste into a chat window,
    // and safe in scrollback — because holding it is not enough to join
    // anything. Redeeming the challenge inside it still takes a member of
    // the lab approving it and a daemon still holding the verifier.
    const readable = decodeRequest(encodeRequest(fields));
    expect(readable).toEqual(fields);
  });

  it("does not carry the verifier the daemon proves itself with", () => {
    // Guarded rather than merely intended. `encodeRequest` takes six named
    // fields and nothing else, so a caller cannot widen the blob by handing
    // it a bigger object.
    const withSecret = { ...fields, verifier: "the-secret" } as PairRequest;
    expect(decodeRequest(encodeRequest(withSecret))).toEqual(fields);
  });
});
