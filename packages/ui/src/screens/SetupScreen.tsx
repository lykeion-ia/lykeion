import { useEffect, useState, type FormEvent } from "react";
import { postAuth } from "../lib/auth-request";
import { AuthShell, Field, SubmitButton } from "./auth-chrome";
import { Wizard } from "./setup/Wizard";

/**
 * What the daemon standing in front of this page will hand over so its
 * machine can be paired without anybody being asked to approve themselves.
 *
 * Every field about the machine comes from the daemon rather than from the
 * browser. A browser knows its own user agent; it does not know which daemon
 * build is running here or what this platform is called, and a page guessing
 * either would put a wrong answer into the lab's own record of the machine.
 */
interface CoLocatedPairing {
  challenge: string;
  state: string;
  redirect: string;
  name: string;
  platform: string;
  daemonVersion: string;
}

/**
 * Asks the daemon in front of this page for the secrets of its open pairing
 * request, or `undefined` when there is no such daemon — this same screen is
 * served by a lab on another computer, where the answer is a 404 or a 409 and
 * the machine-name field has nothing to do with anything.
 */
async function coLocatedPairing(): Promise<CoLocatedPairing | undefined> {
  try {
    const res = await fetch("/setup/challenge", { credentials: "same-origin" });
    if (!res.ok) return undefined;
    return (await res.json()) as CoLocatedPairing;
  } catch {
    return undefined;
  }
}

/**
 * Whether a Lykeion daemon is serving this page, which is the same question
 * as whether this screen is step 2 of a first run.
 *
 * Asked of `/setup/machine` rather than of `/setup/challenge`, because that
 * route answers whatever the topology is. `/setup/challenge` refuses when the
 * lab is not on this machine, and a browser that reached a lab across a
 * network is not inside a wizard at all — it is somebody opening a lab
 * somebody else deployed, and progress chrome there would count out three
 * steps of a flow they never started.
 */
async function insideAFirstRun(): Promise<boolean> {
  try {
    return (await fetch("/setup/machine", { credentials: "same-origin" })).ok;
  } catch {
    return false;
  }
}

/**
 * The one-time screen a brand-new lab opens on. It creates the owner and
 * signs them in; afterwards the server stops offering the route, so this
 * never appears again.
 */
export function SetupScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [labName, setLabName] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Absent until the daemon answers, and absent forever on a lab reached
  // over a network — where this screen is exactly what it always was.
  const [pairing, setPairing] = useState<CoLocatedPairing | undefined>(undefined);
  const [machineName, setMachineName] = useState("");
  // Whether to wear the wizard's own chrome. Creating the lab is step 2 of a
  // first run, and the join branch's `which lab?` is the same step wearing
  // different content — which is exactly why the strip counts without naming.
  const [inWizard, setInWizard] = useState(false);

  useEffect(() => {
    let live = true;
    void insideAFirstRun().then((inside) => {
      if (live) setInWizard(inside);
    });
    void coLocatedPairing().then((found) => {
      if (!live || found === undefined) return;
      setPairing(found);
      // Prefilled rather than asked for. The machine's own name is something
      // this computer knows about itself, and a field a researcher has to
      // fill in to describe the computer they are sitting at is ceremony.
      setMachineName((current) => (current === "" ? found.name : current));
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Runs the pairing handshake the redirect would have run, from the page
   * that already holds both ends of it.
   *
   * Deliberately not fatal. The lab exists and the researcher is signed in to
   * it by the time this runs — a machine that failed to pair is a machine
   * they can pair afterwards, and refusing to let them into the lab they just
   * created would be a worse answer than an unpaired machine.
   */
  const pairThisMachine = async (found: CoLocatedPairing): Promise<void> => {
    // `pairMachine`, camelCase, because the RPC surface is named after the
    // contract's own method names — `createFetchTransport` derives every path
    // the same way. The snake_case spelling this used to send got a 404 and
    // was swallowed by the deliberate never-fatal handling below, so the lab
    // was created, the machine did not join it, and nothing said so.
    const asked = await fetch("/rpc/pairMachine", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        args: [
          {
            name: machineName.trim() === "" ? found.name : machineName.trim(),
            platform: found.platform,
            daemonVersion: found.daemonVersion,
            challenge: found.challenge,
            redirect: found.redirect,
          },
        ],
      }),
    });
    if (!asked.ok) return;
    // `{ ok, value }`, because this is the RPC envelope every other call goes
    // through `createFetchTransport` to unwrap — this one talks to the route
    // directly (see the note above about `useApi` being out of reach here), so
    // it has to unwrap it itself. Reading `code` off the top level found
    // nothing, and the never-fatal handling below turned that into a machine
    // that silently did not join the lab it had just created.
    const answer = (await asked.json()) as { value?: { code?: string } };
    const code = answer.value?.code;
    if (typeof code !== "string") return;
    await fetch("/setup/paired", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state: found.state }),
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await postAuth("/auth/setup", { labName, email, displayName, password });
    } catch {
      // The request never reached anyone. Saying so and releasing the form
      // is the whole of it — an unreleased form leaves the only control on
      // the page disabled, with nothing to click and nothing to read.
      setBusy(false);
      setError("could not reach this lab's server");
      return;
    }
    if (res.ok) {
      // Only now, and only here: the code is redeemed against a lab that
      // exists, by a browser signed in to it as the owner it has just made.
      // Both halves of the handshake are in this one tab, which is the whole
      // reason there is nothing to approve.
      if (pairing !== undefined) await pairThisMachine(pairing).catch(() => {});
      // On to step 3, when this screen was step 2 of a first run. The wizard
      // promised three steps and this is the third; without it the flow ends
      // one step early on the workbench, and the agents a researcher came here
      // to sign in to are never offered.
      //
      // Set BEFORE handing over, because `onSignedIn` applies the landing rule
      // and `hasDestination` reads this same hash to decide whether somebody
      // has already chosen where to go. Naming a destination here is choosing.
      if (inWizard) window.location.hash = "#/setup/3";
      return onSignedIn();
    }
    setBusy(false);
    const body = await res.json().catch(() => ({}) as { error?: string });
    setError((body as { error?: string }).error ?? "that did not work");
  };

  const shell = (
    <AuthShell
      title="Create the lab"
      subtitle="You will be its owner: you invite everyone else."
      // The wizard supplies the full-height frame and the footer under it, so
      // this must not claim the window as well — see `AuthShell`'s `framed`.
      framed={!inWizard}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        {/* Asked here because this is the only screen that can ask: the
            route is answered once and never offered again. It is what the
            lab is called everywhere afterwards — on a machine's pairing
            page, in the link back from one, and in Settings. Left blank it
            is simply unnamed, and every one of those places says the
            address instead. */}
        <Field
          label="Lab name"
          type="text"
          value={labName}
          onChange={setLabName}
          hint="What to call this lab. Optional."
          autoFocus
        />
        <Field label="Your name" type="text" value={displayName} onChange={setDisplayName} />
        <Field label="Email" type="email" value={email} onChange={setEmail} />
        <Field label="Password" type="password" value={password} onChange={setPassword} hint="At least 8 characters." />
        {/* Only when a daemon is standing in front of this page. On a lab
            reached over a network this machine is not joining anything, and
            a field naming it would be asking about a computer that has
            nothing to do with what is being created. */}
        {pairing !== undefined && (
          <Field
            label="This machine"
            type="text"
            value={machineName}
            onChange={setMachineName}
            hint="What this computer is called in the lab. It joins as you create it."
          />
        )}
        {error && <p className="text-sub text-danger">{error}</p>}
        <SubmitButton busy={busy} idle="Create the lab" working="Creating…" />
      </form>
    </AuthShell>
  );

  // Step 2 of a first run when a daemon is serving this page, and nothing but
  // itself when a browser reached a lab across a network — where counting out
  // three steps would describe a flow that researcher never started.
  return inWizard ? (
    <Wizard step={2} total={3}>
      {shell}
    </Wizard>
  ) : (
    shell
  );
}
