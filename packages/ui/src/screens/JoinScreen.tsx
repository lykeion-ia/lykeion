import { useState, type FormEvent } from "react";
import { postAuth } from "../lib/auth-request";
import { AuthShell, Field, SubmitButton } from "./auth-chrome";

/**
 * The way in for someone an owner already invited. The code names the lab;
 * this is where it turns into an account of their own. Outside the shell,
 * like the other two doorway screens — there is no workbench to frame until
 * somebody is behind it.
 */
export function JoinScreen({
  code,
  onSignedIn,
  onSignIn,
}: {
  code: string;
  onSignedIn: () => void;
  /** Leave the invite behind and sign in instead. Somebody who already has
   *  an account here — a second copy of the link, a bookmark, a colleague
   *  forwarding one — cannot use this screen, and without this there is
   *  nothing on it but a form that will keep refusing them. */
  onSignIn: () => void;
}) {
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
      res = await postAuth("/auth/redeem-invite", { code, email, displayName, password });
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
    // The server's own words: it is the only party that knows whether the
    // code was unknown, revoked, already used, or expired.
    const body = await res.json().catch(() => ({}) as { error?: string });
    setError((body as { error?: string }).error ?? "that invite did not work");
  };

  return (
    <AuthShell title="Join the lab" subtitle="You were invited. Create your account to get in.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Your name" type="text" value={displayName} onChange={setDisplayName} autoFocus />
        <Field label="Email" type="email" value={email} onChange={setEmail} />
        <Field label="Password" type="password" value={password} onChange={setPassword} hint="At least 8 characters." />
        {error && <p className="text-sub text-danger">{error}</p>}
        <SubmitButton busy={busy} idle="Join the lab" working="Joining…" />
        <button
          type="button"
          onClick={onSignIn}
          className="mt-1 self-start text-sub text-fg-muted underline-offset-2 hover:text-fg hover:underline"
        >
          Already have an account? Sign in
        </button>
      </form>
    </AuthShell>
  );
}

export default JoinScreen;
