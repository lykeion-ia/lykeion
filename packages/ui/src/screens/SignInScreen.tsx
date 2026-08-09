import { useState, type FormEvent } from "react";
import { postAuth } from "../lib/auth-request";
import { AuthShell, Field, SubmitButton } from "./auth-chrome";

/**
 * The way into a lab that already exists. Outside the shell, because there
 * is no workbench to frame until somebody is behind it.
 */
export function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await postAuth("/auth/signin", { email, password });
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
    // The server's own words: it is the only party that knows why.
    const body = await res.json().catch(() => ({}) as { error?: string });
    setError((body as { error?: string }).error ?? "that sign-in did not work");
  };

  return (
    <AuthShell title="Sign in" subtitle="This lab's workbench.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Email" type="email" value={email} onChange={setEmail} autoFocus />
        <Field label="Password" type="password" value={password} onChange={setPassword} />
        {error && <p className="text-sub text-danger">{error}</p>}
        <SubmitButton busy={busy} idle="Sign in" working="Signing in…" />
      </form>
    </AuthShell>
  );
}
