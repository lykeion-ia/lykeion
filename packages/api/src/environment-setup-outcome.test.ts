import { expect, it } from "vitest";

import { boundedRedactedUtf8, redactCredentialLike } from "./environment-setup-outcome";

it("redacts incomplete authorities, environment keys, JSON keys, and quoted whitespace values", () => {
  const secrets = [
    "github secret with spaces",
    "aws secret with spaces",
    "json secret with spaces",
    "unfinished-authority-secret",
    "bearer secret with spaces",
  ];
  const unsafe = [
    `GITHUB_TOKEN = "${secrets[0]}"`,
    `AWS_SECRET_ACCESS_KEY='${secrets[1]}'`,
    `{"token": "${secrets[2]}"}`,
    `download failed at https://alice:${secrets[3]}`,
    `Authorization: "Bearer ${secrets[4]}"`,
  ].join(" | ");

  const redacted = redactCredentialLike(unsafe);
  for (const secret of secrets) expect(redacted).not.toContain(secret);
  expect(redacted.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(secrets.length);
});

it("redacts conservatively before a UTF-8 byte cap without splitting Unicode", () => {
  const secret = "unicode-boundary-secret";
  const bounded = boundedRedactedUtf8(
    `${"界".repeat(1_350)} {"GITHUB_TOKEN": "${secret} with whitespace"}`,
    4_096,
  );

  expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(4_096);
  expect(bounded).not.toContain(secret);
  expect(bounded).toContain("[redacted]");
  expect(bounded.endsWith("\ud800")).toBe(false);
});
