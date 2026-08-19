import {
  curatedCatalog,
  LykeionError,
  type Agent,
  type Connector,
  type LykeionApi,
  type Group,
  type SkillEntry,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { Row } from "../store/store";
import { nextSeq } from "../store/migrations";

export type ConfigSurfaceApi = Pick<
  LykeionApi,
  | "listSkills" | "createSkill" | "setSkillEnabled"
  | "listAgents" | "upsertAgent"
  | "listConnectors" | "addConnector" | "setConnectorEnabled" | "setConnectorSkipApprovals"
  | "connectorCatalog" | "listConnectorTools"
  | "listGroups" | "createGroup"
>;

function toSkillEntry(row: Row): SkillEntry {
  return {
    name: row.name as string,
    description: row.description as string,
    body: row.body as string,
    enabled: row.enabled === 1,
  };
}

/** Agents keep their whole record in a JSON `payload` column beside the
 *  primary key. Nothing queries into an agent's tool list, so a column per
 *  field would mean a migration every time the contract grows one;
 *  `JSON.stringify`/`JSON.parse` round a field that was never set back to an
 *  absent key, not one holding `undefined`, because neither function ever
 *  materializes one. */
/**
 * Read one stored record, or say which one could not be read. A payload
 * that will not parse — a truncated write, a hand-edited row — would
 * otherwise throw out of the list method and reach the caller as "the
 * workspace server failed to handle that call", with every other record in
 * the table unreadable and nothing naming the one at fault.
 */
function parsePayload<T>(row: Row, key: string): T {
  try {
    return JSON.parse(row.payload as string) as T;
  } catch {
    throw new LykeionError("invalid", `the stored record for ${key} is unreadable`);
  }
}

function toAgent(row: Row): Agent {
  return parsePayload<Agent>(row, row.name as string);
}

/** A connector's `enabled`/`skipApprovals` are read from their own columns,
 *  never from the payload: `setConnectorEnabled` and
 *  `setConnectorSkipApprovals` update only the column, so a stored payload's
 *  copy of either flag would go stale the first time either is toggled. */
function toConnector(row: Row): Connector {
  const payload = parsePayload<Connector>(row, row.name as string);
  return {
    ...payload,
    enabled: row.enabled === 1,
    skipApprovals: row.skip_approvals === 1,
  };
}

function toGroup(row: Row): Group {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    ...(row.lead_agent === null ? {} : { leadAgent: row.lead_agent as string }),
    memberAgents: JSON.parse(row.member_agents as string) as string[],
    memberUsers: JSON.parse((row.member_users as string) ?? "[]") as string[],
    createdTs: row.created_ts as number,
    // Stored separately even though nothing revises a Group yet.
    // The contract's other implementation orders this list on `updatedTs`,
    // so the day an edit lands, a server that had folded the two together
    // would keep answering in creation order and no test would notice,
    // because nothing can create the difference until then.
    updatedTs: row.updated_ts as number,
  };
}

/**
 * Sort by a name the way a person reading the list would. SQLite's `NOCASE`
 * folds ASCII only, so every accented name would sort after `Z`, while the
 * contract's other implementation compares with the locale's own rules —
 * two labs answering differently for the same skill names is exactly what
 * the shared suite exists to prevent.
 *
 * No tiebreak is needed and none would be reachable: every one of these
 * tables is keyed by the name being sorted on, so two rows cannot share
 * one. The rows are read in insertion order regardless, which is what a
 * stable sort would fall back on if that ever stopped being true.
 */
function byName<T>(rows: T[], nameOf: (row: T) => string): T[] {
  return [...rows].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

export function configSurfaceApi(deps: Deps): ConfigSurfaceApi {
  const { store, now } = deps;
  const { record } = deps.changes;
  return {
    // ---- skills ----

    async listSkills() {
      return byName(
        store.all(`SELECT * FROM skills ORDER BY seq ASC`).map(toSkillEntry),
        (skill) => skill.name,
      );
    },

    async createSkill(skill) {
      store.tx(() => {
        // Keyed by name: a second create with a name already in use replaces
        // rather than duplicates, the same rule `upsertAgent` follows below.
        // The insertion sequence is kept from the first write, which no
        // contract method can observe — these lists sort by the name, and
        // the name is the key — but is the truthful thing to store.
        // `nextSeq` is still spent on a conflicting write, where the value
        // it produces is discarded; harmless, just not free.
        const seq = nextSeq(store);
        store.run(
          `INSERT INTO skills (name, description, body, enabled, seq) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(name) DO UPDATE SET description = excluded.description, body = excluded.body, enabled = 1`,
          [skill.name, skill.description, skill.body, seq],
        );
        record("skill-created", { name: skill.name });
      });
    },

    async setSkillEnabled(name, enabled) {
      store.tx(() => {
        if (!store.get(`SELECT name FROM skills WHERE name = ?`, [name]))
          throw new LykeionError("not-found", `no such skill: ${name}`);
        store.run(`UPDATE skills SET enabled = ? WHERE name = ?`, [enabled ? 1 : 0, name]);
        record("skill-updated", { name });
      });
    },

    // ---- agents ----

    async listAgents() {
      return byName(
        store.all(`SELECT * FROM agents ORDER BY seq ASC`).map(toAgent),
        (agent) => agent.name,
      );
    },

    async upsertAgent(agent) {
      store.tx(() => {
        // Keyed by name, so a second write with the same name replaces
        // rather than duplicating. The insertion sequence is kept from the
        // first write — replacing an agent does not make it new — the same
        // way `createSkill` above keeps its own, and unobservable for the
        // same reason. `nextSeq` is still spent on a conflicting write,
        // where the value it produces is discarded.
        const seq = nextSeq(store);
        store.run(
          `INSERT INTO agents (name, payload, seq) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET payload = excluded.payload`,
          [agent.name, JSON.stringify(agent), seq],
        );
        record("agent-updated", { name: agent.name });
      });
    },

    // ---- connectors ----

    async listConnectors() {
      return byName(
        store.all(`SELECT * FROM connectors ORDER BY seq ASC`).map(toConnector),
        (connector) => connector.name,
      );
    },

    async addConnector(connector) {
      store.tx(() => {
        const seq = nextSeq(store);
        store.run(
          `INSERT INTO connectors (name, payload, enabled, skip_approvals, seq) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             payload = excluded.payload, enabled = excluded.enabled, skip_approvals = excluded.skip_approvals`,
          [connector.name, JSON.stringify(connector), connector.enabled ? 1 : 0, connector.skipApprovals ? 1 : 0, seq],
        );
        record("connector-added", { name: connector.name });
      });
    },

    async setConnectorEnabled(name, enabled) {
      store.tx(() => {
        if (!store.get(`SELECT name FROM connectors WHERE name = ?`, [name]))
          throw new LykeionError("not-found", `no such connector: ${name}`);
        store.run(`UPDATE connectors SET enabled = ? WHERE name = ?`, [enabled ? 1 : 0, name]);
        record("connector-updated", { name });
      });
    },

    async setConnectorSkipApprovals(name, skip) {
      store.tx(() => {
        if (!store.get(`SELECT name FROM connectors WHERE name = ?`, [name]))
          throw new LykeionError("not-found", `no such connector: ${name}`);
        store.run(`UPDATE connectors SET skip_approvals = ? WHERE name = ?`, [skip ? 1 : 0, name]);
        record("connector-updated", { name });
      });
    },

    async connectorCatalog() {
      // A constant in the server rather than a table: nothing writes it.
      return curatedCatalog();
    },

    async listConnectorTools(name) {
      if (!store.get(`SELECT name FROM connectors WHERE name = ?`, [name]))
        throw new LykeionError("not-found", `no such connector: ${name}`);
      // Discovery needs a live MCP session with the connector's server, which
      // needs an actual machine — the same failure every kernel and run
      // method in `absentApi` answers honestly rather than faking.
      throw new LykeionError(
        "unsupported",
        "no machine is connected to this lab — install the Lykeion daemon on a machine that can reach this connector's server.",
      );
    },

    // ---- groups ----

    async listGroups() {
      // Newest first, insertion sequence breaking the tie — the same rule
      // `listResearches` follows.
      return store
        .all(`SELECT * FROM research_groups ORDER BY updated_ts DESC, seq DESC`)
        .map(toGroup);
    },

    async createGroup(input) {
      const ts = now();
      // One sequence number serves both the id and the seq column, for the
      // same reason createResearch and createTask use only one: a second
      // nextSeq call would burn a value nothing reads, and would do it
      // outside this transaction, so a rollback couldn't even reclaim it.
      return store.tx(() => {
        const seq = nextSeq(store);
        const id = `rg_${seq}`;
        store.run(
          `INSERT INTO research_groups (id, name, description, lead_agent, member_agents, member_users, created_ts, updated_ts, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            input.name,
            // The suite asserts an absent description reads back as "", not
            // as undefined: the screen renders the field either way.
            input.description ?? "",
            input.leadAgent ?? null,
            JSON.stringify(input.memberAgents ?? []),
            JSON.stringify(input.memberUsers ?? []),
            ts,
            ts,
            seq,
          ],
        );
        record("group-created", { id });
        return toGroup(store.get(`SELECT * FROM research_groups WHERE id = ?`, [id])!);
      });
    },
  };
}
