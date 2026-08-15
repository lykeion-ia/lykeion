#!/usr/bin/env node
/**
 * The command every message this program prints has always named.
 *
 * A shebanged wrapper rather than the bundle itself, for two reasons. The
 * bundle is built output and is not in the repository, so a file that had to
 * be regenerated to stay executable would be a permission bit somebody has to
 * remember; and the wrapper is what `package.json`'s `bin` points at, which
 * means the name on PATH is stable while what it loads can move.
 *
 * Nothing is done here beyond loading. Every argument, every flag and every
 * exit status is `main.ts`'s to decide — a wrapper that interpreted anything
 * would be a second parser to keep in agreement with the first.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "main.js");

// Said plainly rather than left to a module-resolution error naming a path
// nobody chose. An installed copy always has this; a checkout that has never
// been built does not, and the way out is one command.
if (!existsSync(bundle)) {
  process.stderr.write(
    `lykeion is installed but not built: ${bundle} is missing.\n` +
      `Run "pnpm --filter @lykeion/daemon build" in the repository, or re-run scripts/install.sh.\n`,
  );
  process.exit(1);
}

await import(bundle);
