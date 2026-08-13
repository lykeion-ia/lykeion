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

/**
 * What asking a CLI from an empty home actually showed.
 *
 * Four states rather than a boolean, because `proven: false` folded together
 * three facts that call for different treatment — and one of them was not a
 * failure at all. The pairing page has to say which happened: "this agent can
 * read your own installation" and "nobody could read what this agent said"
 * are both refusals, and a researcher can act on one of them.
 */
export type RedirectState =
  /** Asked from a home created empty a moment ago, and answered signed out.
   *  A CLI that honours `homeEnv` cannot be signed in there. */
  | "redirect-works"
  /** Answered signed in from that same empty home, so it is reading from
   *  somewhere else — and there is only one somewhere else it could be. */
  | "redirect-broken"
  /** Answered in a shape this row could not read. Nothing was shown either
   *  way, which is not the same as showing that nothing is wrong. */
  | "not-understood"
  /** Did not answer at all. Disproves nothing, and is not remembered. */
  | "nothing-shown";

export interface RedirectProof {
  state: RedirectState;
  reason?: string;
}

/**
 * Whether this proof should keep the agent off the page.
 *
 * `redirect-broken` gates because the isolation demonstrably does not hold.
 * `not-understood` gates because a row whose status arguments are wrong has
 * demonstrated nothing, and certifying an isolation on the strength of a
 * usage error is exactly what this rung exists to prevent.
 *
 * `nothing-shown` does not gate, and that is a deliberate loosening rather
 * than a restatement of what this file used to do. Until now every non-proof
 * held a row back, silence included. The trade is bounded on both sides: the
 * answer is not cached, so the next cycle asks again; and a CLI too broken to
 * answer this question answers rung 7 no better, where it reads as signed out
 * and is offered a sign-in rather than a run. What is genuinely given up is
 * the narrow case of a CLI that fails this question and passes rung 7 in the
 * same cycle — one cycle of an agent offered on an unproven isolation,
 * against taking a working install off the page for five minutes over one bad
 * moment.
 */
export function gatesOffering(proof: RedirectProof): boolean {
  return proof.state === "redirect-broken" || proof.state === "not-understood";
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
  // `not-understood` rather than a state of its own: nothing was shown about
  // this CLI's home, which is exactly what that state means, and it gates for
  // the same reason.
  if (isolation === undefined)
    return { state: "not-understood", reason: `${entry.name} declares no isolation` };

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
        state: "not-understood",
        reason: `${entry.name} answered in a way this row could not read, so nothing about ${isolation.homeEnv} was shown either way`,
      };
    else if (state.signedIn)
      answer = {
        state: "redirect-broken",
        reason: `${entry.name} answered as signed in from a home created empty a moment ago, so ${isolation.homeEnv} is not redirecting it`,
      };
    else answer = { state: "redirect-works" };
  } catch {
    // A CLI that could not answer has disproven nothing, and refusing to offer
    // an agent because its status command fell over once would take a working
    // install off the page. It is not proven either, so the row waits for a
    // cycle where the question gets an answer.
    answered = false;
    answer = {
      state: "nothing-shown",
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
