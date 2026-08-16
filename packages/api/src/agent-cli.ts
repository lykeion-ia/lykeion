/**
 * A coding-agent CLI detected on the researcher's machine — the ACP backend a
 * run can be routed to (Claude Code, Codex, Gemini, Copilot, Cursor, …). Real-
 * data-ready: the in-memory implementation detects none (returns empty); a
 * real implementation would probe PATH for known ACP agents and report which
 * are installed, and which of those can actually be reached over ACP.
 * camelCase on the wire. No CLIs are ever seeded — an install with nothing
 * detected is empty.
 */
/**
 * One thing an agent lets a session change about how it works — its model,
 * its reasoning effort, its own mode. Normalised from what the session
 * advertised, so nothing downstream knows which of the two wire mechanisms
 * produced it, including the setter.
 */
export interface AgentOption {
  id: string;
  /** "model", "thought_level", "mode", … — what the option governs. */
  category: string;
  /** Absent when the session named no current value, never `null`. */
  currentValue?: string;
  choices: Array<{ value: string; label: string; description?: string }>;
}

export interface AgentCli {
  id: string;
  name: string;
  /** The launch command probed on PATH (e.g. "claude", "gemini"). */
  command: string;
  /** Detected version, or "" when unknown / not installed. */
  version: string;
  /** Whether the CLI is installed and launchable on this machine. */
  available: boolean;
  /** The machine this command was found on. */
  machineId: string;
  /** Whether a run can actually be started against this CLI: its ACP adapter
   *  resolved on PATH and answered `initialize`. A CLI can be `available`
   *  and still not be this — the adapter that speaks ACP for it is a
   *  separate program, found and asked separately. */
  sessionReady: boolean;
  /** Why `sessionReady` is false, in words a researcher can act on — the
   *  adapter's own refusal when it has one, or that no adapter was found at
   *  all. Absent when `sessionReady` is true: nothing needs explaining. */
  sessionReadyReason?: string;
  /**
   * What this agent advertised when a session was opened with it. EMPTY when
   * it advertised nothing — a valid agent may offer no choice at all —
   * ABSENT when no session could be opened to ask, which is a different fact
   * and never rendered as the first.
   *
   * Per agent and per machine, for the same reason `sessionReady` is: a
   * machine can hold two adapters that answer differently.
   */
  options?: AgentOption[];
  /**
   * Whether this machine's copy of the CLI is signed in to the vendor.
   *
   * `false` and ABSENT are different answers and are never rendered the
   * same. `false` is a CLI that was asked and said no — the one state a
   * researcher can fix in a minute, and the only one that earns a *Sign in*
   * control. Absent is a CLI nothing got far enough to ask: not installed,
   * no adapter, an isolation that could not be demonstrated. Offering a
   * sign-in for one of those spawns nothing and leaves the row waiting
   * forever.
   */
  signedIn?: boolean;
  /**
   * Which account it is signed in as, when the CLI says. Absent when it is
   * signed out, when it does not report one, and when nothing asked.
   *
   * This is the researcher's own identity with a third party, and it goes no
   * further than the member who paired the machine — `listAgentClis` and
   * `listMachines` both gate `clis` on `owner_id`, and that gate is what
   * stands between a colleague and the address somebody signed in with.
   */
  account?: string;
  /**
   * Why this agent is held back by something the researcher cannot act on,
   * in words written for them rather than for a log.
   *
   * Distinct from `sessionReadyReason`, which is the diagnostic: it names
   * the environment variable, the adapter, the command. This is the sentence
   * a row shows a person, and its presence is what tells a row it has
   * nothing to offer — a held-back row carries no control at all, because
   * there is no button that would change the fact.
   */
  heldBackReason?: string;
  /**
   * Who published the ACP adapter this agent would be run through, known
   * once one has actually resolved on the machine.
   *
   * It decides whether the researcher is asked anything. `community` means
   * neither the CLI's vendor nor the ACP project published the program that
   * will run inside the boundary holding that agent's credential, and
   * running it is a decision only they can make.
   */
  adapterProvenance?: "vendor" | "protocol" | "community";
  /**
   * The adapter as declared — the bare executable name a catalogue row names,
   * never a path.
   *
   * With the three below it, this is what a researcher is actually deciding
   * about when they are asked to allow a community adapter: which program,
   * which build, and where it is. Absent until an adapter has resolved.
   */
  adapterCommand?: string;
  /** What that program answered when asked its own version, when anything
   *  asked. Absent is a fact worth showing rather than a blank: a build
   *  nobody can name is a build nobody can vet. */
  adapterVersion?: string;
  /** Where it resolved on that machine's PATH. The same name can be several
   *  programs, and this is the one that would actually run. */
  adapterPath?: string;
}
