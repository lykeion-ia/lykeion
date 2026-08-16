import {
  CORE_PHASES,
  curatedCatalog,
  DISCIPLINES,
  expandPrompt,
  LykeionError,
  METHOD_PHASES,
  type Agent,
  type Connector,
  type Discipline,
  type LykeionApi,
  type MethodPhase,
  type ResearchGroup,
  type SkillEntry,
  type Workflow,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { Row } from "../store/store";
import { nextSeq } from "../store/migrations";

export type ConfigSurfaceApi = Pick<
  LykeionApi,
  | "listSkills" | "createSkill" | "setSkillEnabled"
  | "listAgents" | "upsertAgent"
  | "listWorkflows" | "upsertWorkflow" | "runWorkflow"
  | "listConnectors" | "addConnector" | "setConnectorEnabled" | "setConnectorSkipApprovals"
  | "connectorCatalog" | "listConnectorTools"
  | "listResearchGroups" | "createResearchGroup"
>;

function toSkillEntry(row: Row): SkillEntry {
  return {
    name: row.name as string,
    description: row.description as string,
    body: row.body as string,
    enabled: row.enabled === 1,
  };
}

/** Agents and workflows keep their whole record in a JSON `payload` column
 *  beside the primary key. Nothing queries into an agent's tool list or a
 *  workflow's placeholders, so a column per field would mean a migration
 *  every time the contract grows one; `JSON.stringify`/`JSON.parse` round
 *  a field that was never set back to an absent key, not one holding
 *  `undefined`, because neither function ever materializes one. */
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

/**
 * What a stored workflow payload may hold: the contract's shape, plus the
 * free-text grouping key and the two absent fields a record written against an
 * earlier contract carries instead.
 */
type StoredWorkflow = Omit<Workflow, "discipline" | "phases"> & {
  discipline?: string;
  phases?: string[];
  category?: string;
};

/** The nearest discipline for a free-text grouping key. Anything unrecognised
 *  is `general`, which is truthful — nobody said which field it was. */
const CATEGORY_DISCIPLINE: Record<string, Discipline> = {
  biology: "biology",
  genomics: "biology",
  rnaseq: "biology",
  chemistry: "chemistry",
  physics: "physics",
  neuroscience: "neuroscience",
  clinical: "medicine",
  medicine: "medicine",
  climate: "earth-science",
  literature: "general",
  general: "general",
};

/**
 * A workflow's payload is JSON off disk, so that it typechecks says nothing
 * about what is in it. Both fields the list groups and renders on are checked
 * against their unions rather than cast into them: an unlabelled group and a
 * phase with no label are both worse than a value that reads as `general`.
 */
function toWorkflow(row: Row): Workflow {
  const { category, ...stored } = parsePayload<StoredWorkflow>(
    row,
    row.id as string,
  );
  const discipline = DISCIPLINES.includes(stored.discipline as Discipline)
    ? (stored.discipline as Discipline)
    : (CATEGORY_DISCIPLINE[category ?? ""] ?? "general");
  // Order is preserved because a workflow's phases are a subsequence of the
  // spine, and dropping an unknown one keeps the rest reading correctly.
  const phases = (stored.phases ?? []).filter((phase): phase is MethodPhase =>
    METHOD_PHASES.includes(phase as MethodPhase),
  );
  return {
    ...stored,
    discipline,
    phases: phases.length > 0 ? phases : CORE_PHASES,
  };
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

function toResearchGroup(row: Row): ResearchGroup {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    ...(row.lead_agent === null ? {} : { leadAgent: row.lead_agent as string }),
    memberAgents: JSON.parse(row.member_agents as string) as string[],
    createdTs: row.created_ts as number,
    // Stored separately even though nothing revises a Research Group yet.
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

    // ---- workflows ----

    async listWorkflows() {
      return byName(
        store.all(`SELECT * FROM workflows ORDER BY seq ASC`).map(toWorkflow),
        (workflow) => workflow.id,
      );
    },

    async upsertWorkflow(workflow) {
      store.tx(() => {
        const seq = nextSeq(store);
        store.run(
          `INSERT INTO workflows (id, payload, seq) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
          [workflow.id, JSON.stringify(workflow), seq],
        );
        record("workflow-updated", { id: workflow.id });
      });
    },

    async runWorkflow(id, values) {
      const row = store.get(`SELECT * FROM workflows WHERE id = ?`, [id]);
      if (!row) throw new LykeionError("not-found", `no such workflow: ${id}`);
      return expandPrompt(toWorkflow(row), values);
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

    // ---- research groups ----

    async listResearchGroups() {
      // Newest first, insertion sequence breaking the tie — the same rule
      // `listStudies` follows.
      return store
        .all(`SELECT * FROM research_groups ORDER BY updated_ts DESC, seq DESC`)
        .map(toResearchGroup);
    },

    async createResearchGroup(input) {
      const ts = now();
      // One sequence number serves both the id and the seq column, for the
      // same reason createStudy and createTask use only one: a second
      // nextSeq call would burn a value nothing reads, and would do it
      // outside this transaction, so a rollback couldn't even reclaim it.
      return store.tx(() => {
        const seq = nextSeq(store);
        const id = `rg_${seq}`;
        store.run(
          `INSERT INTO research_groups (id, name, description, lead_agent, member_agents, created_ts, updated_ts, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            input.name,
            // The suite asserts an absent description reads back as "", not
            // as undefined: the screen renders the field either way.
            input.description ?? "",
            input.leadAgent ?? null,
            JSON.stringify(input.memberAgents ?? []),
            ts,
            ts,
            seq,
          ],
        );
        record("research-group-created", { id });
        return toResearchGroup(store.get(`SELECT * FROM research_groups WHERE id = ?`, [id])!);
      });
    },
  };
}
