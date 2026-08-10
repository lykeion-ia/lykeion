import { useState, type FormEvent } from "react";
import { postAuth } from "../lib/auth-request";
import { AuthShell, Field, SubmitButton } from "./auth-chrome";

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
    if (res.ok) return onSignedIn();
    setBusy(false);
    const body = await res.json().catch(() => ({}) as { error?: string });
    setError((body as { error?: string }).error ?? "that did not work");
  };

  return (
    <AuthShell title="Create the lab" subtitle="You will be its owner: you invite everyone else.">
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
        {error && <p className="text-sub text-danger">{error}</p>}
        <SubmitButton busy={busy} idle="Create the lab" working="Creating…" />
      </form>
    </AuthShell>
  );
}
