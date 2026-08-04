import { useState, type FormEvent } from "react";
import { postAuth } from "../lib/auth-request";
import { AuthShell, Field, SubmitButton } from "./auth-chrome";

/**
 * The one-time screen a brand-new lab opens on. It creates the owner and
 * signs them in; afterwards the server stops offering the route, so this
 * never appears again.
 */
export function SetupScreen({ onSignedIn }: { onSignedIn: () => void }) {
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
      res = await postAuth("/auth/setup", { email, displayName, password });
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
        <Field label="Your name" type="text" value={displayName} onChange={setDisplayName} autoFocus />
        <Field label="Email" type="email" value={email} onChange={setEmail} />
        <Field label="Password" type="password" value={password} onChange={setPassword} hint="At least 8 characters." />
        {error && <p className="text-[12.5px] text-danger">{error}</p>}
        <SubmitButton busy={busy} idle="Create the lab" working="Creating…" />
      </form>
    </AuthShell>
  );
}
