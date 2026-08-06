import type { AgentCli, AgentOption } from "@lykeion/api";

/**
 * What an agent advertised about how it can be run, read off the agent
 * itself. There is no catalogue here and there is not meant to be: a list
 * kept in this product is a second source of truth that goes stale the week
 * a provider ships a model.
 */

/** The option governing which model a turn runs on, or undefined when this
 *  agent offered none. */
export function modelOptionOf(cli: AgentCli | undefined): AgentOption | undefined {
  return cli?.options?.find((option) => option.category === "model");
}

/**
 * Why there is no choice to offer. Two different facts, and the pill says
 * which: an agent that advertised nothing genuinely offers none, while one
 * no session could be opened against has not been asked yet and will fill
 * in from the Task's first Send.
 *
 * Undefined when there IS a choice — nothing needs explaining.
 */
export function noChoiceReason(cli: AgentCli | undefined): string | undefined {
  if (modelOptionOf(cli) !== undefined) return undefined;
  if (cli === undefined) return "no agent is selected";
  if (cli.options === undefined)
    return `${cli.name} has not been asked what it offers yet — it will be, on this Task's first message`;
  return `${cli.name} offers no choice of model`;
}
