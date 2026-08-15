import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../auth-chrome";
import { Wizard } from "./Wizard";

/**
 * Step 2 on the branch where the lab is somewhere else.
 *
 * The same step number as creating one, wearing different content — which is
 * the whole reason the strip above carries dots and not names. A researcher
 * who answered *somewhere else* is on step 2 of 3 exactly as one who answered
 * *on this machine* is, and neither is told the other's story.
 *
 * The notice is the only warning this flow gives, and it is here because this
 * is the only place the flow leaves. Everything else happens on one page; this
 * hands the tab to a lab on another computer and waits to be sent back.
 */
export function JoinLabScreen() {
  const [lab, setLab] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch("/setup/machine", { credentials: "same-origin" })
      .then((res) => (res.ok ? (res.json() as Promise<{ name: string }>) : undefined))
      .then((found) => {
        // Prefilled rather than asked for, the same way the other branch
        // prefills it: a computer knows what it is called.
        if (live && found !== undefined) setName((current) => (current === "" ? found.name : current));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      // The route that has always done this. What changes on this branch is
      // only what asks — a screen inside the wizard rather than a page the
      // daemon rendered — and it answers with the redirect it always did, so
      // the browser leaves for the lab exactly as it used to.
      res = await fetch("/connect", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lab: lab.trim(), name: name.trim() }),
      });
    } catch {
      setBusy(false);
      setError("could not reach the daemon on this machine");
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { redirect?: string; error?: string };
    // The tab leaves HERE, explicitly. `fetch` follows a redirect itself and
    // never navigates the page, so a route answering 302 would have this
    // screen sitting on a resolved promise holding the lab's HTML while the
    // researcher looked at the form they had just submitted.
    if (res.ok && typeof body.redirect === "string") {
      window.location.assign(body.redirect);
      return;
    }
    setBusy(false);
    setError(body.error ?? "that lab did not take this machine");
  };

  return (
    <Wizard
      step={2}
      total={3}
      // The one step in this flow that can be undone. Nothing has happened
      // yet that going back would have to unpick: no lab was started, no
      // account was created, and the topology this branch recorded is a
      // preference the daemon replaces on the next answer. The other branch's
      // step 2 has already brought a lab up, which is why it offers none.
      onBack={() => {
        window.location.hash = "#/setup/1";
      }}
    >
      <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.03em] text-fg">
        Which lab?
      </h1>
      <p className="mt-3 max-w-[34rem] text-read leading-relaxed text-fg-muted">
        The address of the lab your group runs. This machine will ask to join it.
      </p>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-3">
        <Field
          label="Lab address"
          type="url"
          value={lab}
          onChange={setLab}
          hint="For example https://lab.example.edu"
          autoFocus
        />
        <Field
          label="This machine"
          type="text"
          value={name}
          onChange={setName}
          hint="What this computer is called in that lab."
        />
        {error && <p className="text-sub text-danger">{error}</p>}
        <p className="text-sub leading-snug text-fg-subtle">
          Continuing opens that lab in this tab. Sign in there if you are not already, approve this
          machine, and you will be sent back here.
        </p>
        <button
          type="submit"
          disabled={busy || lab.trim() === "" || name.trim() === ""}
          className="mt-1 self-start rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Opening…" : "Continue to that lab"}
        </button>
      </form>
    </Wizard>
  );
}

export default JoinLabScreen;
