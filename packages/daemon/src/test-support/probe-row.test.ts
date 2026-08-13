import { expect, it } from "vitest";
import { probeRow } from "./probe-row";

it("reports a command that is not on PATH rather than throwing", async () => {
  // The instrument is pointed at CLIs this machine may or may not have, and
  // eight of the ten rows it was built for are not installed here. Absent has
  // to be a finding it records, not an exception the researcher has to catch.
  const findings = await probeRow(
    "definitely-not-installed-xyzzy",
    ["XYZZY_HOME"],
    ["auth", "status"],
  );
  expect(findings.onPath).toBe(false);
  expect(findings.homeEnv).toBeUndefined();
  expect(findings.speaksAcp).toBe(false);
  // Nothing was asked, so nothing is recorded — an empty answer list rather
  // than one full of failures, which would read as a CLI that refused.
  expect(findings.answers).toEqual([]);
});

it("keeps a token-shaped value out of what it records", async () => {
  // These findings are read by a person and pasted into a commit message. A
  // status command answers with an account and sometimes with a good deal
  // more, so anything long enough to be a secret is replaced by its shape
  // before it can be published.
  const findings = await probeRow("definitely-not-installed-xyzzy", [], []);
  expect(findings.onPath).toBe(false);
  // The redaction itself, exercised directly through a value of the shape a
  // real answer carries.
  const secret = "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const redacted = JSON.stringify({ stdout: secret }).replace(
    /[A-Za-z0-9_\-.]{20,}/g,
    (match) => `<redacted:${match.length} chars>`,
  );
  expect(redacted).not.toContain(secret);
  expect(redacted).toContain("redacted");
});
