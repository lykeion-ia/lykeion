import type { AgentOption } from "@lykeion/api";

/**
 * What an agent lets a session change about how it works, read off what the
 * session itself advertised.
 *
 * Two wire mechanisms, one domain model. Nothing below this branches on
 * WHICH CLI it is talking to — only on what the session in front of it
 * advertised — so an agent that changes which mechanism it offers changes
 * nothing else.
 */

/** Which method a set travels on. Chosen from what the session advertised,
 *  never from the agent's name. */
export type OptionSetter = "config" | "model" | "none";

export interface AdvertisedOptions {
  options: AgentOption[];
  setter: OptionSetter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One selectable value, however the agent named its fields. */
function choiceOf(raw: unknown): { value: string; label: string; description?: string } | undefined {
  if (!isRecord(raw)) return undefined;
  const value = str(raw.value) ?? str(raw.id) ?? str(raw.modelId) ?? str(raw.optionId);
  if (value === undefined) return undefined;
  const description = str(raw.description);
  return {
    value,
    label: str(raw.label) ?? str(raw.name) ?? value,
    ...(description === undefined ? {} : { description }),
  };
}

function choicesOf(raw: unknown): Array<{ value: string; label: string; description?: string }> {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? (raw.options ?? raw.choices ?? raw.values)
      : undefined;
  if (!Array.isArray(list)) return [];
  return list.map(choiceOf).filter((choice): choice is NonNullable<typeof choice> => !!choice);
}

function optionOf(raw: unknown): AgentOption | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id) ?? str(raw.configId);
  if (id === undefined) return undefined;
  const choices = choicesOf(raw.options ?? raw.choices ?? raw.type);
  if (choices.length === 0) return undefined;
  const currentValue = str(raw.currentValue) ?? str(raw.value);
  return {
    id,
    category: str(raw.category) ?? id,
    ...(currentValue === undefined ? {} : { currentValue }),
    choices,
  };
}

/** A list an agent advertises under its own key, as one option of the same
 *  shape — so the picker, the cache and the setter all read one thing. */
function listOption(
  raw: unknown,
  id: string,
  listKey: string,
  currentKey: string,
): AgentOption | undefined {
  const source = Array.isArray(raw) ? { [listKey]: raw } : raw;
  if (!isRecord(source)) return undefined;
  const choices = choicesOf(source[listKey]);
  if (choices.length === 0) return undefined;
  const currentValue = str(source[currentKey]);
  return {
    id,
    category: id,
    ...(currentValue === undefined ? {} : { currentValue }),
    choices,
  };
}

/**
 * What a `session/new` response says this session can be told to change.
 *
 * `configOptions` wins wherever both are offered: it returns the updated
 * state, so a set can be confirmed rather than assumed, and it carries
 * reasoning effort and mode through the same door.
 */
export function readAdvertised(result: unknown): AdvertisedOptions {
  if (!isRecord(result)) return { options: [], setter: "none" };
  const config = Array.isArray(result.configOptions)
    ? result.configOptions
        .map(optionOf)
        .filter((option): option is AgentOption => option !== undefined)
    : [];
  const models = listOption(result.models, "model", "availableModels", "currentModelId");
  const modes = listOption(result.modes, "mode", "availableModes", "currentModeId");

  if (config.length > 0) {
    const carried = modes && !config.some((option) => option.category === "mode") ? [modes] : [];
    return { options: [...config, ...carried], setter: "config" };
  }
  if (models) return { options: [models, ...(modes ? [modes] : [])], setter: "model" };
  return { options: modes ? [modes] : [], setter: "none" };
}

/**
 * The agent's own ordinary working mode: the one that edits files and runs
 * commands within its own workspace.
 *
 * The operating-system boundary is the outer bound, and an agent's mode may
 * narrow it and can never widen it. So the full-access mode — whose whole
 * meaning is reaching outside the workspace — is never selected: an agent
 * told it has full access, inside a boundary that says otherwise, produces a
 * turn full of denials that look like breakage rather than policy.
 *
 * Undefined when nothing offered is an ordinary working mode, or when the
 * session is already in one. The boundary does not depend on the agent's
 * cooperation, which is the point of moving it into the kernel, so leaving
 * the mode alone is safe.
 */
export function ordinaryWorkingMode(mode: AgentOption): string | undefined {
  const values = mode.choices.map((choice) => choice.value);
  const working = values.find((value) => ORDINARY_WORKING_MODES.has(value));
  return working === undefined || working === mode.currentValue ? undefined : working;
}

/** The values an agent uses for "edit files and run commands, within my own
 *  workspace". A value not named here is left alone rather than guessed at. */
const ORDINARY_WORKING_MODES = new Set(["agent", "default", "edit", "acceptEdits"]);

/**
 * What a set actually established, read off what came back rather than
 * assumed from what was asked.
 *
 * `session/set_config_option` returns the full updated state, so a set can
 * be CONFIRMED — or found to have been rejected, when the echoed value is
 * not the one asked for. `session/set_model` returns nothing at all, so the
 * value is applied and unconfirmed, which is a different fact and is never
 * reported as the first.
 */
export interface SetOutcome {
  /** What the option holds now, as far as anything can tell. */
  value: string;
  /** True only when the agent echoed the new value back. */
  confirmed: boolean;
}

export function confirmationOf(result: unknown, id: string, asked: string): SetOutcome {
  if (!isRecord(result) || !Array.isArray(result.configOptions))
    return { value: asked, confirmed: false };
  const echoed = result.configOptions
    .map(optionOf)
    .find((option): option is AgentOption => option?.id === id);
  const current = echoed?.currentValue;
  if (current === undefined) return { value: asked, confirmed: false };
  return { value: current, confirmed: current === asked };
}
