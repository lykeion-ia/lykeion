import { useCallback, useEffect, useState } from "react";
import type { AgentCli } from "@lykeion/api";
import { AgentsScreen } from "./AgentsScreen";
import { Wizard } from "./Wizard";

/**
 * Step 3 of the first run: the agents on THIS machine, asked of this machine.
 *
 * The daemon is what answers, not the lab, and that is not an implementation
 * detail. Only the machine's own front door can start a CLI login — a sign-in
 * opens a browser flow against a vendor and writes a credential into a home
 * this daemon owns, none of which a lab on another computer can do or should
 * be able to ask for. The same reason `GET /agents` and `POST /agents/signin`
 * live on the loopback server and nowhere else.
 *
 * It also means this step works on the branch where the lab is somewhere
 * else, where nothing of the lab's is reachable through this origin at all.
 */

/** What the daemon's own `/agents` route answers with. Narrower than
 *  `AgentCli` on purpose: it is the sign-in question asked directly, not a
 *  probe cycle's full ladder, and it costs no adapter spawn to answer. */
interface DaemonAgent {
  agent: string;
  name: string;
  available: boolean;
  signedIn: boolean;
  account?: string;
  /** The adapter this agent would run through, as it stands on THIS machine.
   *  Absent when none resolved — see the daemon's `adapterOnThisMachine`. */
  adapterCommand?: string;
  adapterPath?: string;
  /** Whether a decision about that adapter is outstanding. */
  consentNeeded?: boolean;
}

/**
 * The daemon's answer in the shape the list reads.
 *
 * Two fields stay absent because this route genuinely does not know them —
 * which build of the CLI is installed, and whether the isolation was
 * demonstrated — and the row renders an absent field as nothing to say rather
 * than as a fact. Filling them in with defaults would put a wrong answer on
 * screen; the lab has the full ladder, and Machines is where it is shown.
 */
function asCli(agent: DaemonAgent): AgentCli {
  return {
    id: agent.agent,
    name: agent.name,
    command: agent.agent,
    version: "",
    available: agent.available,
    runtimeId: "",
    // This step is about what is waiting on the researcher, and being signed
    // in is as far as this route can speak to. A row is never told it can run
    // on the strength of an answer that was not about running.
    sessionReady: false,
    // Only when the daemon actually answered it. That route now lists the
    // whole catalogue, and most of those rows have no confined home to be
    // asked from — a `signedIn: undefined` written here would be a key that
    // exists holding no answer, which is the one shape the row's own rules
    // are not written for.
    ...(typeof agent.signedIn === "boolean" ? { signedIn: agent.signedIn } : {}),
    ...(agent.account === undefined ? {} : { account: agent.account }),
    ...(agent.adapterCommand === undefined ? {} : { adapterCommand: agent.adapterCommand }),
    ...(agent.adapterPath === undefined ? {} : { adapterPath: agent.adapterPath }),
    // Reported as `community` only while the decision is actually
    // outstanding, which is the one thing this step is for. The daemon knows
    // the provenance either way; a row that carried it after the answer was
    // given would go on offering Review for a question already settled.
    ...(agent.consentNeeded ? { adapterProvenance: "community" as const } : {}),
  };
}

export function AgentsStep({ onDone }: { onDone: () => void }) {
  const [clis, setClis] = useState<AgentCli[]>([]);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/agents", { credentials: "same-origin" });
      if (!res.ok) return;
      const body = (await res.json()) as { agents?: DaemonAgent[] };
      setClis((body.agents ?? []).map(asCli));
    } catch {
      // A machine that cannot answer about its own agents leaves the list
      // empty. Nothing here is required to finish setting up, and a step that
      // refused to render because a read failed would be a dead end at the
      // one moment the researcher is closest to done.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const signIn = (id: string) => {
    void fetch("/agents/signin", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: id }),
      // Read again once the CLI has had a moment with the browser it just
      // opened. The sign-in itself happens outside this page entirely, so
      // there is nothing to await — asking again is the only way to learn.
    }).then(() => setTimeout(() => void reload(), 2000));
  };

  // Recorded here and nowhere else. An acceptance decides what runs beside a
  // credential in a home this daemon owns, so the machine's own front door is
  // the only thing that may write one — see the route's own comment.
  const allow = (id: string) => {
    void fetch("/agents/consent", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: id, accepted: true }),
    }).then(() => void reload());
  };

  return (
    <Wizard step={3} total={3}>
      <AgentsScreen clis={clis} onSignIn={signIn} onAllow={allow} onSkip={onDone} boundList />
    </Wizard>
  );
}

export default AgentsStep;
