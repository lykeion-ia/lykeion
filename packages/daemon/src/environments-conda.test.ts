import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  condaPackageName,
  countCondaPackages,
  explicitLockfileFrom,
  type CondaSolve,
} from "./environments-conda";

/** The solve this file's claims are made against: a REAL `micromamba create
 *  --dry-run --json` for `r-base` and `r-jsonlite`, recorded from micromamba
 *  2.9.0 and kept whole.
 *
 *  Recorded rather than written, and untrimmed, deliberately. The claim these
 *  tests make is about hashes surviving into the lockfile, and a fixture
 *  hand-authored to the shape this file expects would assert that this file
 *  agrees with itself. A trimmed one is worse: it would leave the integrity
 *  claim untested while every test stayed green. */
function solve(): CondaSolve {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "__fixtures__", "micromamba-dry-run.json"), "utf8"),
  ) as CondaSolve;
}

describe("the explicit lockfile a conda solve becomes", () => {
  it("carries every artifact's url and its hash, one per line, under an @EXPLICIT header", () => {
    const lockfile = explicitLockfileFrom(solve());
    const lines = lockfile.split("\n");
    expect(lines[0]).toBe("@EXPLICIT");
    const artifacts = lines.slice(1).filter((line) => line !== "");
    // The fixture is a real solve of two packages; R drags in the rest.
    expect(artifacts.length).toBeGreaterThan(50);
    for (const line of artifacts) {
      expect(line).toMatch(/^https:\/\/conda\.anaconda\.org\/conda-forge\//);
      // A BARE md5 fragment, which is conda's format because it is what the
      // tool actually reads. Written `#sha256=…` the hash is accepted and
      // verified against nothing — measured against micromamba 2.9.0, which
      // refuses even a CORRECT sha256 fragment with "md5 and sha256 sum
      // unknown" and accepts the bare form.
      expect(line).toMatch(/#[0-9a-f]{32}$/);
    }
  });

  it("pins what will be INSTALLED, not merely what must be downloaded", () => {
    // The bug this replaced: `FETCH` omits anything already in this
    // machine's shared package cache, so the second environment a machine
    // resolves produced a lockfile missing most of itself — and every other
    // machine replayed that incomplete text faithfully. Every R environment
    // in a lab shares `r-base`, so this was the ordinary case, not an edge.
    const lockfile = explicitLockfileFrom({
      actions: {
        FETCH: [{ url: "https://x.invalid/new.conda", md5: "a".repeat(32), name: "new" }],
        LINK: [
          { url: "https://x.invalid/new.conda", md5: "a".repeat(32), name: "new" },
          { url: "https://x.invalid/cached.conda", md5: "b".repeat(32), name: "cached" },
        ],
      },
    });
    expect(countCondaPackages(lockfile)).toBe(2);
    expect(lockfile).toContain("cached.conda");
  });

  it("refuses to write a pin the solver gave no hash for", () => {
    // A line a machine would take on trust is worse than no lockfile,
    // because it looks like one.
    expect(() =>
      explicitLockfileFrom({ actions: { LINK: [{ url: "https://x.invalid/a.conda", name: "a" }] } }),
    ).toThrow(/no md5/);
  });

  it("writes a header and no artifacts for a solve that names none", () => {
    // Not an error: an environment whose every package the channel already
    // had is a real answer, and `countCondaPackages` says 0 rather than
    // pretending otherwise. Absent is not zero — but nothing here is absent.
    expect(explicitLockfileFrom({})).toBe("@EXPLICIT\n");
    expect(countCondaPackages(explicitLockfileFrom({}))).toBe(0);
  });
});

describe("counting what an explicit lockfile pins", () => {
  it("counts artifact lines and not the header, blanks or comments", () => {
    const lockfile = [
      "# written by something",
      "@EXPLICIT",
      `https://x.invalid/a.conda#${"a".repeat(32)}`,
      `https://x.invalid/b.conda#${"b".repeat(32)}`,
      "",
    ].join("\n");
    expect(countCondaPackages(lockfile)).toBe(2);
  });

  it("counts every artifact of the recorded solve", () => {
    const solved = solve();
    expect(countCondaPackages(explicitLockfileFrom(solved))).toBe(
      solved.actions?.LINK?.length ?? 0,
    );
  });
});

describe("what conda-forge calls an R library", () => {
  it("prefixes a name the researcher wrote as they would say it", () => {
    expect(condaPackageName("ggplot2")).toBe("r-ggplot2");
    expect(condaPackageName("jsonlite")).toBe("r-jsonlite");
    expect(condaPackageName("tidyverse")).toBe("r-tidyverse");
  });

  it("leaves a name that already carries the prefix alone", () => {
    // `r-base` is the interpreter itself, spelled that way by everyone.
    // Prefixing blindly would ask for `r-r-base`, which does not exist.
    expect(condaPackageName("r-base")).toBe("r-base");
    expect(condaPackageName("r-matrix")).toBe("r-matrix");
  });
});
