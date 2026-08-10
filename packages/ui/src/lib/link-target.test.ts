import { describe, expect, it } from "vitest";
import { linkTargetOf } from "./link-target";

describe("linkTargetOf", () => {
  it("reads an https URL as external, and asks its own origin for the favicon", () => {
    expect(linkTargetOf("https://www.nature.com/articles/s41586-025-09749-7")).toEqual(
      {
        kind: "external",
        host: "www.nature.com",
        favicon: "https://www.nature.com/favicon.ico",
      },
    );
  });

  it("keeps a non-default port — the favicon belongs to that server, not the host's :443", () => {
    const target = linkTargetOf("http://localhost:8080/docs");
    expect(target).toEqual({
      kind: "external",
      host: "localhost:8080",
      favicon: "http://localhost:8080/favicon.ico",
    });
  });

  it("reads a relative artifact path as internal, so it resolves against no origin", () => {
    expect(linkTargetOf("artifacts/kinome_genes.csv")).toEqual({
      kind: "internal",
    });
    expect(linkTargetOf("/artifacts/kinome_genes.csv")).toEqual({
      kind: "internal",
    });
  });

  /**
   * The narrow predicate is the point: only a scheme that is provably the web
   * earns a request to somewhere else. Anything a reply can contain that merely
   * PARSES as a URL must not.
   */
  it("reads every other scheme as internal", () => {
    for (const href of [
      "mailto:someone@example.com",
      "file:///Users/x/notes.md",
      "data:text/plain,hi",
      "ftp://example.com/pub",
    ]) {
      expect(linkTargetOf(href)).toEqual({ kind: "internal" });
    }
  });

  it("reads junk and a missing href as internal rather than throwing", () => {
    expect(linkTargetOf("http://")).toEqual({ kind: "internal" });
    expect(linkTargetOf("")).toEqual({ kind: "internal" });
    expect(linkTargetOf(undefined)).toEqual({ kind: "internal" });
  });
});
