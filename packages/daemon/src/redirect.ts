import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogueEntry } from "./agent-registry";
import type { RunCommand } from "./agent-auth";

/**
 * Whether a CLI actually honours the environment variable its row says
 * redirects its configuration.
 *
 * A declaration written from a vendor's documentation is a hypothesis, and
 * there is one way it can be wrong that nothing downstream would notice: if
 * `homeEnv` does not do what the row claims, every run of that agent quietly
 * reads the researcher's own installation — their credentials, their skills,
 * their tool servers — while this daemon believes it moved them somewhere of
 * its own. Every other rung would still be green, because from the outside
 * the agent would be working.
 *
 * So it is proven rather than assumed, and proven by asking the CLI rather
 * than by reading the disk: point it at a home created empty a moment ago and
 * ask who it is signed in as. A CLI that honours the variable cannot be
 * signed in there. One that answers "signed in" is answering from somewhere
 * else, and there is only one somewhere else it could be.
 *
 * A state read by ASKING survives the vendor moving their storage, which is
 * the same reason the sign-in check asks rather than reads.
 */
const proofs = new Map<string, RedirectProof>();

export interface RedirectProof {
  proven: boolean;
  reason?: string;
}

/** Forgets every cached proof. Tests only — a daemon re-asks when the CLI's
 *  own build changes, which is what `cacheKey` carries. */
export function forgetRedirectProofs(): void {
  proofs.clear();
}

/**
 * `cacheKey` identifies the exact CLI build being asked: its resolved path and
 * its version. Asked once per build rather than once per probe cycle, because
 * the answer cannot change without the program changing — and an upgrade IS
 * the program changing, so a new key asks again.
 */
export async function provesRedirect(
  entry: CatalogueEntry,
  cacheKey: string,
  run: RunCommand,
): Promise<RedirectProof> {
  const isolation = entry.isolation;
  if (isolation === undefined) return { proven: false, reason: `${entry.name} declares no isolation` };

  const cached = proofs.get(cacheKey);
  if (cached !== undefined) return cached;

  // Neither the researcher's home nor ours. Ours may legitimately be signed
  // in, which would make a signed-in answer prove nothing at all — the whole
  // experiment rests on the home being one nobody has ever signed into.
  const scratch = mkdtempSync(join(tmpdir(), "lykeion-redirect-"));
  let answer: RedirectProof;
  let answered = true;
  try {
    const output = await run(entry.command, [...isolation.auth.status.args], {
      [isolation.homeEnv]: scratch,
    });
    const state = isolation.auth.status.read(output);
    // `recognised !== true`, not `=== false`. The field is optional and
    // absent means "understood" everywhere else, which is right for the
    // sign-in check and wrong here: a row written from documentation gets its
    // status arguments and its `recognised` handling from the same guess, so
    // a row that forgets the field would silently inherit the behaviour this
    // exists to remove — with a passing typecheck. Fail closed instead, and
    // let a row earn its proof by saying it understood.
    if (state.recognised !== true)
      // Nobody understood this, so nothing was observed. It reads as "signed
      // out" to the pairing page, and folding the two together here would
      // certify an isolation on the strength of a usage error — a row whose
      // status arguments are wrong would pass this rung having demonstrated
      // nothing at all, which is exactly what it exists to catch.
      answer = {
        proven: false,
        reason: `${entry.name} answered in a way this row could not read, so nothing about ${isolation.homeEnv} was shown either way`,
      };
    else if (state.signedIn)
      answer = {
        proven: false,
        reason: `${entry.name} answered as signed in from a home created empty a moment ago, so ${isolation.homeEnv} is not redirecting it`,
      };
    else answer = { proven: true };
  } catch {
    // A CLI that could not answer has disproven nothing, and refusing to offer
    // an agent because its status command fell over once would take a working
    // install off the page. It is not proven either, so the row waits for a
    // cycle where the question gets an answer.
    answered = false;
    answer = {
      proven: false,
      reason: `${entry.name} did not answer when asked where it keeps its sign-in`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Remembered only when the CLI actually answered. A real answer — proven, or
  // a redirect demonstrably not working — cannot change without the program
  // changing, so re-asking it every cycle would run the researcher's CLI to be
  // told the same thing. Silence is not an answer to remember: caching it
  // would stand a working install down until the daemon restarts, on the
  // strength of one bad moment, which is what the sentence above promises it
  // will not do.
  if (answered) proofs.set(cacheKey, answer);
  return answer;
}
