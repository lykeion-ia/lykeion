import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * The screens' own class names, and whether anything styles them.
 *
 * A rename that sweeps `.tsx` and stops at the stylesheet leaves markup asking
 * for rules that no longer exist. Nothing fails: React renders the class,
 * the browser finds no rule, and the surface comes out as a column of
 * unstyled text with its labels and counts run together — which is how
 * `Study` becoming `Research` shipped, all 38 rules orphaned at once.
 *
 * No test could have caught it, because every test here asserts on roles and
 * text and none of them can see a stylesheet. This one reads both sides as
 * files and compares the names, which is the only place the two are supposed
 * to agree.
 */

/** Vitest runs with the package as its root, so `src` hangs off the cwd.
 *  Asserted rather than assumed: a wrong path here would find no files, and
 *  "no class is unstyled" is exactly what an empty scan reports — this test
 *  would pass by looking at nothing. */
const UI_SRC = join(process.cwd(), "src");

/** Every `.css` under `src`, as one string. Read together because a class
 *  may be defined anywhere — `screens.css` is a convention, not a rule. */
function allStyles(): string {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".css")) found.push(readFileSync(path, "utf8"));
    }
  };
  walk(UI_SRC);
  return found.join("\n");
}

/** Every class token the screens render whose name is this product's own —
 *  the prefixed, hyphenated ones. Tailwind utilities and the shared `btn`
 *  family are deliberately out of scope: they are defined by a framework and
 *  by `components.css`, and sweeping them in would make this test a lint of
 *  someone else's vocabulary. */
function screenClassNames(): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
        const source = readFileSync(path, "utf8");
        for (const [, value] of source.matchAll(/className=\{?"([^"]+)"/g))
          for (const token of value.split(/\s+/))
            if (/^(research|group|colleague|expert|machine|settings)-[a-z-]+$/.test(token))
              names.add(token);
      }
    }
  };
  walk(join(UI_SRC, "screens"));
  return [...names].sort();
}

it("reads both sides, rather than passing on an empty scan", () => {
  // The guard the two tests below rest on. Both are absence assertions, and
  // an absence is what a scan of nothing reports too.
  expect(allStyles().length).toBeGreaterThan(1000);
  expect(screenClassNames().length).toBeGreaterThan(10);
});

it("styles every class the screens render", () => {
  const styles = allStyles();
  const unstyled = screenClassNames().filter((name) => !styles.includes(`.${name}`));

  // Named rather than counted: a diff of 38 numbers says nothing about which
  // surface went bare, and the point of failing here is to say so.
  expect(unstyled).toEqual([]);
});

it("leaves behind no rule the screens stopped asking for", () => {
  // The other direction, and the one that says a rename FINISHED. A
  // stylesheet still carrying `.study-card` after the markup moved to
  // `.research-card` is dead weight that reads as live code — and the next
  // person renaming something greps for the old name, finds it, and believes
  // it is still in use.
  const styles = allStyles();
  const orphaned = [...new Set([...styles.matchAll(/\.(study|research-group)-[a-z-]+/g)].map((m) => m[0]))];

  expect(orphaned).toEqual([]);
});
