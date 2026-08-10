/**
 * What a link inside an agent's reply POINTS AT — the one decision that governs
 * how it is drawn, and the only one that can cause a network request.
 *
 * A citation of a paper and a reference to a file this Task produced are
 * different things wearing the same markdown syntax, and the reader has to be
 * able to tell them apart at a glance. Only the first is somewhere else on the
 * web; the second is this workspace's own output.
 *
 * `external` is deliberately narrow — `http:` and `https:` and nothing else.
 * The favicon of an external link is fetched from the site itself, so widening
 * this predicate widens the set of hosts a reply can make the reader's browser
 * talk to merely by being rendered. Everything not provably a web address —
 * a relative artifact path, `mailto:`, a bare word, junk mid-stream — is
 * `internal`, which draws a local glyph and requests nothing.
 *
 * Pure and DOM-free on purpose: "a relative path fires no request" is then a
 * property of this function, assertable without rendering anything.
 */
export type LinkTarget =
  | { kind: "external"; host: string; favicon: string }
  | { kind: "internal" };

const INTERNAL: LinkTarget = { kind: "internal" };

export function linkTargetOf(href: string | undefined): LinkTarget {
  if (!href) return INTERNAL;
  let url: URL;
  try {
    // A relative href throws here without a base, which is the answer we want:
    // no base is passed precisely so that `artifacts/x.csv` cannot resolve
    // against the app's own origin and come back looking external.
    url = new URL(href);
  } catch {
    return INTERNAL;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return INTERNAL;
  return {
    kind: "external",
    // `host`, not `hostname`: a non-default port is part of which server this
    // is, and the favicon has to be asked of that same server.
    host: url.host,
    favicon: `${url.origin}/favicon.ico`,
  };
}
