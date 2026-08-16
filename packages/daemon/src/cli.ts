/**
 * The command, and nothing else.
 *
 * This file exists so that `main.ts` does not run when it is imported. It is
 * the module every part of this daemon is reached through — `reportIfChanged`,
 * the config reader, the run loop — and while it also invoked itself on the
 * way in, importing any one of those started the whole program. Under vitest
 * that was worse than noise: the test runner's own argv names no command, so
 * the fall-through reached `serve`, which binds this machine's ports and
 * claims the researcher's real data directory. A suite that imported one
 * function for one assertion paired a machine and spawned a lab.
 *
 * The bundle is built from here and still written to `dist/main.js`: that path
 * is what `bin/lykeion.js` loads, what `pnpm start` runs, and what the tests
 * that spawn a real daemon name. Moving the entry is not a reason to move the
 * output.
 */
import { failed, main } from "./main";

await main().catch(failed);
