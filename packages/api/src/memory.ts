/**
 * In-memory `LykeionApi` — seed data for the browser surface, dev, and the
 * e2e smoke tests. Deterministic (no clocks/random beyond an injectable id
 * counter) so tests are stable.
 */

import { LykeionError } from "./errors";
import type {
  LykeionApi,
  NameTaskInput,
  NewGroup,
  NewResearch,
  NewTask,
  PairMachineInput,
  TaskPatch,
} from "./api";
import { cleanSummaryTitle, promptNeedsSummary, titleFromPrompt } from "./task-title";
import type {
  Assignee,
  Research,
  ResearchDetail,
  Task,
} from "./types";
import type { KernelEnvCreateInput, KernelEnvDeclaration, KernelEnvManager, Language } from "./machine";
import type {
  Conversation,
  ConversationSummary,
  Message,
  NewConversation,
} from "./conversation";
import type { Finding } from "./review";
import type { ArtifactBlob } from "./artifact";
import type {
  Agent,
  CatalogEntry,
  Connector,
  McpTool,
  Skill,
  SkillEntry,
} from "./customization";
import { methodSkills } from "./method-skills";
import type { Group } from "./group";
import { assertAvatarDataUrl } from "./account";
import type { Invite, Member, Role, User } from "./account";
import type { Usage } from "./usage";
import type { WorkspaceSettings } from "./settings";
import type {
  ActiveRunSnapshot,
  DelegateSubagentInput,
  ExecutionLogEntry,
  Plan,
  PermissionRequest,
  QuestionRequest,
  RunDecision,
  RunEvent,
  RunEventFrame,
  RunHandle,
  RunRecord,
  StartRunInput,
  StepStatus,
  TaskTurn,
  TurnItem,
} from "./run";
import { MAX_TURNS_OUTSTANDING } from "./run";

interface SimulatedRun extends RunHandle {
  onEventFrom(cursor: number, cb: (event: RunEvent) => void): () => void;
  onFrameFrom(cursor: number, cb: (frame: RunEventFrame) => void): () => void;
}

/**
 * The shape `createInMemoryApi` starts life from. Exported because it is
 * already that function's parameter type — a caller assembling a seed by
 * hand could depend on it but not name it.
 */
export interface Seed {
  researches: Research[];
  tasks: Task[];
  /** Threads about Tasks — what the Inbox lists. */
  conversations: Conversation[];
  /** Every message in them, across all threads. */
  messages: Message[];
  /**
   * How far each member has read in each thread: conversation id → user id →
   * the `ts` they had read up to. Held here rather than on the wire types
   * because "unread" is a fact about a READER, and `Conversation` is one
   * record shared by everyone in it.
   */
  readTs: Record<string, Record<string, number>>;
  /** Reviewer findings, keyed by task id. */
  findings: Record<string, Finding[]>;
  /** Everyone with an account on this lab's workbench. */
  users: User[];
  /** Their standing, one per user. */
  members: Member[];
  /** Outstanding invites. */
  invites: Invite[];
  /** Which user I am, as a `User.id`. */
  me: string;
  /** Customization-engine starter content. */
  skills: SkillEntry[];
  agents: Agent[];
  connectors: Connector[];
  groups: Group[];
  /**
   * Turns the store starts life with, given per Task. Replaying them through
   * `appendTurn` is what makes a seeded transcript and a run one the same
   * object — the roll-up fields on the Task are derived, never seeded.
   */
  transcripts: {
    taskId: string;
    turns: { prompt: string; messages: string[]; status?: "ok" | "failed" }[];
  }[];
}

/**
 * The built-in curated catalog of scientific-database connectors. The stdio
 * `command`/`args` are illustrative placeholders until the servers are
 * chosen.
 */
export function curatedCatalog(): CatalogEntry[] {
  const stdio = (arg: string): CatalogEntry["server"] => ({
    command: "uvx",
    args: [arg],
    env: {},
  });
  return [
    {
      name: "PubMed",
      description:
        "Search biomedical literature and abstracts from NCBI PubMed.",
      category: "literature",
      server: stdio("mcp-pubmed"),
    },
    {
      name: "UniProt",
      description:
        "Look up protein sequences, functions, and annotations from UniProt.",
      category: "proteins",
      server: stdio("mcp-uniprot"),
    },
    {
      name: "Ensembl",
      description:
        "Query genomes, genes, and variants from the Ensembl database.",
      category: "genomics",
      server: stdio("mcp-ensembl"),
    },
    {
      name: "PDB",
      description:
        "Fetch macromolecular 3D structures from the RCSB Protein Data Bank.",
      category: "structures",
      server: stdio("mcp-rcsb-pdb"),
    },
    {
      name: "ChEMBL",
      description:
        "Search bioactive molecules and drug-like compounds from ChEMBL.",
      category: "chemistry",
      server: stdio("mcp-chembl"),
    },
  ];
}

/**
 * This core's stand-in for a summarizer: the opening clause, six words of it.
 *
 * A real lab names a Task by spending an agent CLI on somebody's machine, and
 * this core has neither. It fakes one the same way it fakes a run — well
 * enough that the surface can be driven end to end in a browser, and
 * deterministically, so a test that asserts a name gets the same one twice.
 * The words come out of the prompt rather than out of a phrase book because a
 * fabricated title that has nothing to do with the message would make the
 * seeded lab read as though the naming were broken.
 */
function localSummary(prompt: string): string {
  const clause = prompt.trim().split(/(?<=[.!?])\s+|\n/)[0] ?? "";
  return clause.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
}

/** Infer a MIME type from a path's extension. */
function inferContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "csv":
      return "text/csv";
    case "tsv":
      return "text/tab-separated-values";
    case "json":
      return "application/json";
    case "ipynb":
      return "application/x-ipynb+json";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
    case "log":
      return "text/plain";
    default:
      return "text/plain";
  }
}

/**
 * Seeded artifact blobs for the viewers — one per viewer family so the
 * table/chart, image, PDF, and notebook surfaces are reachable and testable in
 * the browser without a real run. camelCase, base64 for binary.
 */
export function fixtureArtifacts(): Record<string, ArtifactBlob> {
  // A small orientation-tuning table: a label column + three numeric columns,
  // so the TableChartViewer can render a dense table and both chart forms
  // (a scatter of the first two numeric columns; a bar of the first).
  const csv =
    "neuron,orientation_deg,tuning_index,snr_db\n" +
    "n01,0,0.81,12.4\n" +
    "n02,30,0.74,10.9\n" +
    "n03,60,0.63,9.2\n" +
    "n04,90,0.88,13.1\n" +
    "n05,120,0.59,8.4\n" +
    "n06,150,0.71,11.0\n" +
    "n07,180,0.66,9.8\n";

  // A valid 1×1 PNG (one opaque pixel).
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOwz34KAAJ8AZBp/ytJAAAAAElFTkSuQmCC";

  // A minimal, valid single-page PDF (correct xref offsets) that renders the
  // words "Lykeion artifact" — real bytes, so the embed shows a page.
  const pdf =
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyNDAgMTgwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA4MCA+PgpzdHJlYW0KQlQgL0YxIDE2IFRmIDI0IDEyMCBUZCAoTHlrZWlvbiBhcnRpZmFjdCkgVGogMCAtMjggVGQgKHJlc3VsdHMvcmVwb3J0LnBkZikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNzEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0NDEKJSVFT0YK";

  // A minimal nbformat-4 notebook: one markdown cell, one code cell whose
  // execute_result carries a text/plain output.
  const notebook = JSON.stringify(
    {
      cells: [
        {
          cell_type: "markdown",
          metadata: {},
          source: [
            "# Orientation tuning\n",
            "\n",
            "Fit tuning curves per neuron and summarize drift after deprivation.",
          ],
        },
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [
            {
              output_type: "stream",
              name: "stdout",
              text: ["loaded 7 neurons from results/out.csv\n"],
            },
            {
              output_type: "execute_result",
              execution_count: 1,
              metadata: {},
              data: {
                "text/plain": ["mean tuning index: 0.72"],
              },
            },
          ],
          source: [
            "import pandas as pd\n",
            "df = pd.read_csv('results/out.csv')\n",
            "print(f'loaded {len(df)} neurons from results/out.csv')\n",
            "round(df.tuning_index.mean(), 2)",
          ],
        },
      ],
      metadata: {
        kernelspec: { name: "python3", display_name: "Python 3" },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  );

  return {
    "results/out.csv": {
      path: "results/out.csv",
      contentType: "text/csv",
      encoding: "utf8",
      data: csv,
    },
    "results/fig.png": {
      path: "results/fig.png",
      contentType: "image/png",
      encoding: "base64",
      data: png,
    },
    "results/report.pdf": {
      path: "results/report.pdf",
      contentType: "application/pdf",
      encoding: "base64",
      data: pdf,
    },
    "results/analysis.ipynb": {
      path: "results/analysis.ipynb",
      contentType: "application/x-ipynb+json",
      encoding: "utf8",
      data: notebook,
    },
  };
}

/** A fixed timestamp base so seed data is deterministic (2026-07-01). */
const T0 = 1_782_000_000;

/** What ran a turn when no lab did. This core answers turns itself, and
 *  naming the simulation is better than leaving the field empty and letting
 *  a reader take the absence for a turn that predates the field. */
const SIMULATED_AGENT = "simulated";

/**
 * The two people every seed starts from. A lab always has an owner; the
 * second member exists so that assignment, mentions and attribution have
 * somewhere to point on a fresh install.
 */
function seedPeople(): { users: User[]; members: Member[] } {
  const you: User = {
    id: "u_you",
    email: "you@lab.example",
    displayName: "You",
    createdTs: T0 - 400 * 86_400,
  };
  const amara: User = {
    id: "u_amara",
    email: "amara@lab.example",
    displayName: "Amara",
    createdTs: T0 - 120 * 86_400,
  };
  return {
    users: [you, amara],
    // The roster is not held in join order: the owner opened the lab, the
    // second member arrived nearly a year later, and `listMembers` is what
    // puts them in joined-date order for a reader.
    members: [
      { user: amara, role: "member", joinedTs: amara.createdTs },
      { user: you, role: "owner", joinedTs: you.createdTs },
    ],
  };
}

/**
 * Five cross-domain researches — deliberately general (systems neuroscience,
 * genomics, climate, chemistry, economics), to show the workbench is not a
 * single vertical. The example task graph lives in "Cross-modal plasticity".
 */
export function defaultSeed(): Seed {
  const people = seedPeople();
  const me = "u_you";
  const researches: Research[] = [
    st(
      "s_cmp",
      "CMP",
      "Cross-modal plasticity in the brain",
      12,
      "Whether visual cortex reallocated to touch after whisker deprivation recovers its original tuning, measured by chronic two-photon calcium imaging across days.",
      "Two-photon calcium imaging in mouse V1, chronic windows, sessions registered across days. Traces are ΔF/F unless stated. Report neuron counts from data/summary.txt, never from an intermediate pass. Drop ROIs below the SNR floor before any tuning fit, and say so when you have.",
    ),
    st(
      "s_gen",
      "GEN",
      "Single-cell atlas of KRAS-mutant tumors",
      9,
      "A cell-type atlas of the KRAS-mutant tumor microenvironment, built from 10x lanes across twelve resected samples.",
    ),
    st(
      "s_cli",
      "CLI",
      "Attribution of 2025 North Atlantic marine heatwaves",
      6,
      "How much of the 2025 North Atlantic heatwave season is attributable to forced warming rather than internal variability.",
    ),
    st(
      "s_che",
      "CHE",
      "Covalent inhibitor scaffolds for KRAS G12C",
      4,
      "Ranking acrylamide and related warheads for selective covalent engagement of the G12C cysteine.",
    ),
    st(
      "s_eco",
      "ECO",
      "Minimum-wage effects on regional employment",
      3,
      "Regional employment response to staged minimum-wage increases, using a synthetic-control design over county-level payroll data.",
    ),
  ];

  const tasks: Task[] = [
    tk(
      "t_1",
      1,
      "s_cmp",
      "background",
      "Survey cross-modal plasticity literature",
      "done",
      "medium",
      { kind: "user", userId: "u_you" },
    ),
    tk(
      "t_2",
      2,
      "s_cmp",
      "hypothesis",
      "Formalize the compensatory-rewiring hypothesis",
      "done",
      "high",
      { kind: "user", userId: "u_you" },
    ),
    tk(
      "t_3",
      3,
      "s_cmp",
      "methods",
      "Preprocess two-photon calcium traces",
      "in-review",
      "high",
      { kind: "user", userId: "u_you" },
    ),
    tk(
      "t_4",
      4,
      "s_cmp",
      "methods",
      "Register sessions across days",
      "in-progress",
      "medium",
      { kind: "user", userId: "u_amara" },
    ),
    tk(
      "t_5",
      5,
      "s_cmp",
      "results",
      "Fit orientation tuning curves per neuron",
      "todo",
      "high",
      { kind: "user", userId: "u_you" },
    ),
    tk(
      "t_6",
      6,
      "s_cmp",
      "results",
      "Quantify tuning drift after deprivation",
      "todo",
      "urgent",
      { kind: "user", userId: "u_you" },
    ),
    tk(
      "t_7",
      7,
      "s_cmp",
      "future-directions",
      "Draft a chemogenetic follow-up",
      "todo",
      "low",
      null,
    ),
    tk(
      "t_8",
      8,
      "s_gen",
      "methods",
      "Integrate 10x lanes and remove batch effects",
      "in-progress",
      "high",
      { kind: "user", userId: "u_you" },
    ),
    tk(
      "t_9",
      9,
      "s_gen",
      "results",
      "Cluster and annotate the tumor microenvironment",
      "todo",
      "medium",
      { kind: "user", userId: "u_you" },
    ),
    tk(
      "t_10",
      10,
      "s_cli",
      "methods",
      "Build the ocean-heat-content baseline",
      "in-progress",
      "high",
      { kind: "user", userId: "u_you" },
    ),
    tk(
      "t_11",
      11,
      "s_che",
      "hypothesis",
      "Rank warhead reactivity by DFT",
      "todo",
      "medium",
      { kind: "user", userId: "u_you" },
    ),
    tk(
      "t_12",
      12,
      "s_eco",
      "background",
      "Assemble the county-panel wage dataset",
      "todo",
      "low",
      { kind: "user", userId: "u_you" },
    ),
    // Unfiled: captured before it was clear which research line they belong to.
    // They number on their own Lab-wide run (TSK-1, TSK-2) and surface in Tasks.
    tk(
      "t_13",
      1,
      undefined,
      "background",
      "Chase the reviewer's point about spike sorting drift",
      "todo",
      "medium",
      { kind: "user", userId: "u_you" },
    ),
    tk(
      "t_14",
      2,
      undefined,
      "methods",
      "Ask the core facility about scope time in March",
      "todo",
      "low",
      { kind: "user", userId: "u_amara" },
    ),
  ];

  // Reviewer findings for CMP-3 (t_3, in-review) — matches the inbox
  // reviewer-flag so the Review tab shows real content in the browser/dev.
  // The high finding gates Done until resolved.
  const findings: Record<string, Finding[]> = {
    t_3: [
      {
        id: "rv_cmp3_cellcount",
        class: "value-contradicts-source",
        severity: "high",
        claimId: "c_cellcount",
        claim: "The dataset contains 512 neurons.",
        evidence: "data/summary.txt reports 384, not 512",
        location: "results/summary.md",
        resolved: false,
      },
      {
        id: "rv_cmp3_planstep",
        class: "plan-step-incomplete",
        severity: "medium",
        claimId: "plan-step-2",
        claim: "Drop low-SNR ROIs before tuning",
        evidence:
          'Approved plan step "Drop low-SNR ROIs before tuning" was not completed',
        resolved: false,
      },
    ],
  };

  // Three threads about real seeded Tasks, so the Inbox opens on a
  // conversation worth reading rather than on an empty column. The CMP-3
  // thread carries the same fact the Reviewer flagged in `findings` above —
  // people arguing over a finding is what this surface is for, and a thread
  // that contradicted the record beside it would teach the reader nothing.
  const conversations: Conversation[] = [
    {
      id: "c_1",
      researchId: "s_cmp",
      taskId: "t_3",
      title: "Preprocess two-photon calcium traces",
      participants: [
        { kind: "user", userId: "u_you" },
        { kind: "user", userId: "u_amara" },
        { kind: "agent", name: "reviewer" },
      ],
      createdBy: "u_you",
      createdTs: T0 - 4000,
      updatedTs: T0 - 600,
    },
    {
      id: "c_2",
      researchId: "s_cmp",
      taskId: "t_6",
      title: "Quantify tuning drift after deprivation",
      participants: [
        { kind: "user", userId: "u_you" },
        { kind: "user", userId: "u_amara" },
      ],
      createdBy: "u_amara",
      createdTs: T0 - 5400,
      updatedTs: T0 - 5000,
    },
    {
      id: "c_3",
      researchId: "s_gen",
      taskId: "t_8",
      title: "Integrate 10x lanes and remove batch effects",
      participants: [
        { kind: "user", userId: "u_you" },
        { kind: "user", userId: "u_amara" },
      ],
      createdBy: "u_you",
      createdTs: T0 - 9000,
      updatedTs: T0 - 9000,
    },
  ];

  const messages: Message[] = [
    {
      id: "m_1",
      conversationId: "c_1",
      author: { kind: "user", userId: "u_you" },
      body: "Traces are on disk for all twelve sessions. Before this moves on — does the 512 figure look right to you?",
      ts: T0 - 4000,
    },
    {
      id: "m_2",
      conversationId: "c_1",
      author: { kind: "user", userId: "u_amara" },
      body: "No. 512 is pre-filter. `data/summary.txt` says 384 after QC, and 384 is the number that belongs in the write-up.",
      ts: T0 - 3600,
    },
    {
      id: "m_3",
      conversationId: "c_1",
      author: { kind: "agent", name: "reviewer" },
      body: "Agreed — I flagged the same contradiction on CMP-3. The low-SNR ROIs were also never dropped, so any tuning fit over these traces is running on cells the SNR floor should have excluded.",
      ts: T0 - 900,
    },
    {
      id: "m_4",
      conversationId: "c_1",
      author: { kind: "user", userId: "u_amara" },
      body: "Then let's re-run the filter before CMP-5 starts. I can take it this afternoon.",
      ts: T0 - 600,
    },
    {
      id: "m_5",
      conversationId: "c_2",
      author: { kind: "user", userId: "u_amara" },
      body: "Putting this on you — the drift analysis needs the same cohort you already know.",
      ts: T0 - 5400,
    },
    {
      id: "m_6",
      conversationId: "c_2",
      author: { kind: "user", userId: "u_you" },
      body: "Taking it. Blocked until CMP-3's filter re-run lands, though.",
      ts: T0 - 5000,
    },
    {
      id: "m_7",
      conversationId: "c_3",
      author: { kind: "user", userId: "u_you" },
      body: "Batch correction is running over all four lanes. I'll post the integration metrics when it finishes.",
      ts: T0 - 9000,
    },
  ];

  // Where each member had read up to. Every seeded stamp sits BELOW `T0`,
  // which is where the instance clock starts: a thread opened at runtime is
  // therefore always newer than the seeded ones and lands at the top of the
  // list, rather than sorting under fixture data from the future.
  //
  // `c_1`'s last two messages land after `u_you`'s mark, which is what gives
  // the Inbox a thread with something genuinely unread in it to open on.
  const readTs: Record<string, Record<string, number>> = {
    c_1: { u_you: T0 - 3600, u_amara: T0 - 600 },
    c_2: { u_you: T0 - 5000, u_amara: T0 - 5000 },
    c_3: { u_you: T0 - 9000, u_amara: T0 - 9000 },
  };

  // Customization-engine starters: domain Skills (one of them disabled, so the
  // surface shows both states), the method Skills, Agents, and a Connector —
  // the set the browser opens with, so it shows real content without a
  // backend.
  const skills: SkillEntry[] = [
    {
      name: "rnaseq",
      description: "RNA-seq differential-expression analysis with DESeq2.",
      body: "# RNA-seq\n\nUse DESeq2: build a count matrix, define the design, then shrink log-fold-changes before reporting.\n",
      enabled: true,
    },
    {
      name: "literature-review",
      description:
        "Summarize and compare findings across papers with citations.",
      body: "# Literature review\n\nSearch, then summarize each source with an explicit citation; flag disagreements between sources.\n",
      enabled: true,
    },
    {
      name: "stats-hygiene",
      description: "Check statistical assumptions before reporting results.",
      body: "# Statistics hygiene\n\nState assumptions, check normality and variance, correct for multiple comparisons, report effect sizes with intervals.\n",
      enabled: false,
    },
    ...methodSkills().map((skill) => ({ ...skill, enabled: true })),
  ];

  const agents: Agent[] = [
    {
      name: "statistician",
      description: "A careful applied statistician.",
      systemPrompt:
        "You are a meticulous statistician. Always state your assumptions and report uncertainty.\n",
      tools: ["Read", "Bash"],
      connectors: [],
    },
    {
      name: "lit-scout",
      description: "Finds and summarizes relevant literature with citations.",
      systemPrompt:
        "You survey the literature. Cite every claim with an explicit source and flag disagreements.\n",
      model: "claude-sonnet-5",
      tools: ["Read", "WebSearch"],
      connectors: [],
    },
  ];

  const connectors: Connector[] = [
    {
      name: "pubmed",
      description: "Search biomedical literature from NCBI PubMed.",
      server: { command: "uvx", args: ["mcp-pubmed"], env: {} },
      enabled: true,
      skipApprovals: false,
    },
  ];

  // The preprocessing chat that IS CMP-3. Its second turn names the two things
  // the Reviewer went on to flag on that Task, so the conversation and the
  // review it drew read as one episode — because they are one record.
  const transcripts: Seed["transcripts"] = [
    {
      taskId: "t_3",
      turns: [
        {
          prompt:
            "Motion-correct the deprivation cohort and segment ROIs from the two-photon stacks.",
          messages: [
            "Ran rigid motion correction over the twelve deprivation-cohort stacks, then non-rigid on the four with residual drift above a quarter pixel.",
            "Segmentation gives 512 ROIs before filtering. Traces are written as ΔF/F to `derived/traces/`, one file per session, with the registration offsets alongside them in `derived/motion/`.",
          ],
        },
        {
          prompt:
            "Summarize what landed, and flag anything a reviewer should check before this moves on.",
          messages: [
            "Twelve sessions are motion-corrected and segmented, and the ΔF/F traces are on disk. That is the preprocessing step done.",
            "Two things to check before this moves on. The neuron count I quoted — 512 — is the pre-filter segmentation figure; `data/summary.txt` reports 384 after quality control, and 384 is the number that belongs in the write-up. And I did not drop the low-SNR ROIs, so any tuning fit on these traces is running over cells the SNR floor should have excluded.",
          ],
        },
      ],
    },
  ];

  return {
    researches,
    tasks,
    conversations,
    messages,
    readTs,
    findings,
    users: people.users,
    members: people.members,
    invites: [],
    me,
    skills,
    agents,
    connectors,
    groups: [],
    transcripts,
  };

  function st(
    id: string,
    key: string,
    title: string,
    n: number,
    description: string,
    agentContext?: string,
  ): Research {
    return {
      id,
      key,
      title,
      description,
      agentContext,
      createdBy: "u_you",
      createdTs: T0 - n * 86_400,
      updatedTs: T0 - 3600,
    };
  }
  function tk(
    id: string,
    number: number,
    /** Absent for an unfiled Task — one that belongs to no Research. */
    researchId: string | undefined,
    stage: Task["stage"],
    title: string,
    status: Task["status"],
    priority: Task["priority"],
    assignee: Assignee | null,
  ): Task {
    return {
      id,
      number,
      researchId,
      stage,
      title,
      status,
      priority,
      assignees: assignee ? [assignee] : undefined,
      createdBy: "u_you",
      // Derived, never seeded: the replay of `transcripts` below stamps it.
      runCount: 0,
      createdTs: T0 - number * 3600,
      updatedTs: T0 - 1800,
    };
  }
}

/**
 * The first-install state: no researches, tasks, conversations, or engine
 * content. Used for the shipped/browser surface so the app opens empty, not
 * pre-populated.
 */
export function emptySeed(): Seed {
  const owner: User = {
    id: "u_you",
    email: "you@lab.example",
    displayName: "You",
    createdTs: 0,
  };
  return {
    researches: [],
    tasks: [],
    conversations: [],
    messages: [],
    readTs: {},
    findings: {},
    users: [owner],
    members: [{ user: owner, role: "owner", joinedTs: 0 }],
    invites: [],
    me: owner.id,
    skills: [],
    agents: [],
    connectors: [],
    groups: [],
    transcripts: [],
  };
}

/**
 * A name every machine will be able to build: one path segment, and nothing
 * else — the same shape the workspace server refuses anything else against
 * (`packages/server/src/api/environments.ts`), which is in turn the shape
 * the daemon's own `envRoot` enforces, because a declaration's name becomes
 * a directory `<workDir>/envs/<name>` that `uv venv --clear` is pointed at
 * and a sandbox policy is rendered around.
 *
 * Held here even though this core has no machines at all. It is not that
 * `../etc` would break something in the browser — nothing here ever builds
 * anything — it is that `kernelEnvCreate` is one contract, exposed to agents
 * as `kernel_env_create` (`index.ts`), and a contract with two answers to the
 * same input is one an agent learns the wrong half of: it names an
 * environment against this core, is told yes, and is told no by the lab that
 * would have had to build it. `environmentDeclarationsConformance` asserts
 * the rule against both cores, which is what actually keeps them together —
 * this constant is only one core's copy of it.
 */
const BUILDABLE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Which manager builds which language — this core's own copy of the
 * derivation `declareEnvironment` makes (`packages/server/src/api/
 * environments.ts`), for the same reason `BUILDABLE_NAME` above is a second
 * copy rather than a shared import: `environmentDeclarationsConformance`
 * holds both cores to one answer, and that is what actually keeps them from
 * drifting apart, not the source location.
 */
const MANAGER_FOR: Record<Language, KernelEnvManager> = { python: "uv", r: "conda" };

/** Options for {@link createInMemoryApi}. */
export interface InMemoryApiOptions {
  /**
   * Reads the current time, in unix **seconds**. Consulted on every write,
   * not once at construction: an instance lives as long as the tab, and a
   * base sampled at boot would report anything created an hour in as an hour
   * old.
   *
   * Omit it for deterministic fixture time — writes tick up from `T0`, one
   * second each, which is what the test suite and the seeded data rely on.
   * Pass `() => Date.now() / 1000` to record real elapsed time, so a row a
   * person creates or edits reads as genuinely new.
   */
  now?: () => number;
}

/**
 * A lab whose members an implementation can answer as, so a caller can hold
 * more than one identity to the contract at once.
 */
export interface InMemoryLab {
  /** An api answering as `userId`, or as the seed's own member when
   *  omitted. Every api this hands back reads and writes the same lab. */
  api(userId?: string): LykeionApi;
  ownerId: string;
  memberId: string;
}

/** Construct an in-memory lab over a seed (defaults to [`defaultSeed`]). */
export function createInMemoryLab(
  seed: Seed = defaultSeed(),
  options?: InMemoryApiOptions,
): InMemoryLab {
  const researches = [...seed.researches];
  const tasks = [...seed.tasks];
  const conversations = [...seed.conversations];
  const messages = [...seed.messages];
  const findings: Record<string, Finding[]> = JSON.parse(
    JSON.stringify(seed.findings),
  ) as Record<string, Finding[]>;
  let counter = tasks.length + researches.length + 1;
  const nextId = (prefix: string) => `${prefix}_${counter++}`;

  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

  const members = clone(seed.members);
  const invites = clone(seed.invites);
  // Deep-copied, not shared: read marks are written on every open, and a
  // shallow copy would let one API instance's reading mark another's threads.
  const readTs = clone(seed.readTs);

  // Customization stores — mutable, independent deep copies of the seed so tests that add
  // or toggle content never leak across API instances.
  const skills: SkillEntry[] = clone(seed.skills);
  const agents: Agent[] = clone(seed.agents);
  const connectors: Connector[] = clone(seed.connectors);
  const groups: Group[] = clone(seed.groups);

  // The lab's environment declarations. No seed carries any — an
  // environment appears only once something declares it, on a fresh
  // install or a seeded one alike. Machine-free by construction, like the
  // real store: this array holds no path and no build state, only what was
  // asked for and the lockfile revision (always 0 here — this core cannot
  // resolve a lockfile, so nothing here ever raises it).
  const kernelEnvs: KernelEnvDeclaration[] = [];

  // Seeded artifact blobs for the viewers, keyed by Research-relative path.
  const artifacts: Record<string, ArtifactBlob> = fixtureArtifacts();

  // Every Task's turns, keyed by task id. A Task with no turns has no entry;
  // `getTask` answers with an empty array for it, because a captured Task is
  // a chat nobody has spoken in yet rather than a missing record.
  const transcripts = new Map<string, TaskTurn[]>();
  // Every run this lab has started, keyed by its id, for `submitRunDecision`
  // to reach one it was addressed to by id alone rather than through the
  // `RunHandle` `startRun`/`delegateSubagent` returned — the same seam a
  // wire transport is built on, where a `RunHandle`'s methods never survive
  // the trip and only its `runId` does.
  const runs = new Map<string, SimulatedRun>();
  // The actor who started each run, keyed the same way — the in-memory
  // analogue of the server's "only the machine's owner may decide": this lab
  // has no machine for a run to belong to, but a run still belongs to
  // whoever started it, and `submitRunDecision` holds every other actor to
  // that the same way the server holds a colleague's un-owned machine to it.
  const runStarters = new Map<string, string>();
  const activeRuns = new Map<
    string,
    {
      taskId: string;
      ownerId: string;
      handle: SimulatedRun;
      source: SimulatedRun;
      snapshot: ActiveRunSnapshot;
    }
  >();
  // Delegated turns are not resumable top-level runs, but they still occupy
  // the same durable transcript sequence. Reserve that position at start so
  // completing ahead of a live parent cannot reuse the parent's number.
  const delegatedSequences = new Map<
    string,
    { taskId: string; sequence: number }
  >();
  const nextTurnSequence = (taskId: string): number =>
    Math.max(
      0,
      ...(transcripts.get(taskId) ?? []).map((turn) => turn.sequence),
      ...[...activeRuns.values()]
        .filter((run) => run.taskId === taskId)
        .map((run) => run.snapshot.sequence),
      ...[...delegatedSequences.values()]
        .filter((run) => run.taskId === taskId)
        .map((run) => run.sequence),
    ) + 1;
  // Every write is stamped from here. The value is strictly increasing, so no
  // two writes in an instance ever tie and none can tie a seeded timestamp;
  // and it is never behind `options.now`, so with a real clock a write records
  // when it happened rather than how long after boot. Without one it simply
  // counts seconds up from `T0`, which is what keeps fixture time reproducible.
  // Floored, because every timestamp on the contract is whole seconds and a
  // real clock hands back a fraction.
  const realNow = () => {
    const read = options?.now?.();
    return read === undefined ? undefined : Math.floor(read);
  };
  let clock = realNow() ?? T0;
  const tick = () => {
    clock = Math.max(clock + 1, realNow() ?? 0);
    return clock;
  };

  // Active color theme, one per person. Unlike the other settings fields
  // this one really round-trips: `setTheme` writes it and `getSettings`
  // reads it back, so the picker's contract is exercised. Held in memory
  // for the session only, so a reload returns to the default.
  //
  // Keyed by user id rather than held as a single value, even though `me`
  // is fixed for the life of an instance and this Map therefore never
  // holds more than one entry here: a scalar and a one-entry Map read back
  // identically from a single fixed identity, so only the keyed shape
  // distinguishes "this person's theme" from "this instance's theme" —
  // and only a store built that way can be checked against more than one
  // identity sharing an instance.
  const themes = new Map<string, string>();

  /** Is this member in the thread? Agents are participants too, but only a
   *  person reads a list, so this asks about a `User.id`. */
  const isParticipant = (c: Conversation, userId: string) =>
    c.participants.some((p) => p.kind === "user" && p.userId === userId);

  const findConversation = (conversationId: string): Conversation => {
    const found = conversations.find((c) => c.id === conversationId);
    if (!found)
      throw new LykeionError(
        "not-found",
        `no such conversation: ${conversationId}`,
      );
    return found;
  };

  /**
   * The row the list draws: the thread, its last word, and how much of it the
   * current member has not seen.
   *
   * A member's OWN messages are never unread — posting is reading — so the
   * count excludes them. Without that, sending a message would badge the
   * thread you just spoke in.
   *
   * `me` is the caller this summary is for, passed in rather than read from
   * the surrounding scope: one lab answers several members, and the unread
   * count is the one field here that is different for each of them.
   */
  const summarize = (
    conversation: Conversation,
    me: string,
  ): ConversationSummary => {
    const mine = messages
      .filter((m) => m.conversationId === conversation.id)
      .sort((a, b) => a.ts - b.ts);
    const mark = readTs[conversation.id]?.[me] ?? 0;
    return {
      conversation,
      lastMessage: mine[mine.length - 1],
      unread: mine.filter(
        (m) =>
          m.ts > mark && !(m.author.kind === "user" && m.author.userId === me),
      ).length,
    };
  };

  /** Drop every matching thread, its messages, and its read marks together.
   *  Used by the Research and Task deletes, which both orphan threads. */
  const dropConversations = (match: (c: Conversation) => boolean) => {
    for (let i = conversations.length - 1; i >= 0; i--) {
      const c = conversations[i];
      if (!match(c)) continue;
      for (let j = messages.length - 1; j >= 0; j--) {
        if (messages[j].conversationId === c.id) messages.splice(j, 1);
      }
      delete readTs[c.id];
      conversations.splice(i, 1);
    }
  };

  const appendTurn = (
    input: Pick<StartRunInput, "researchId" | "taskId" | "prompt">,
    status: "ok" | "failed",
    run: RunRecord | undefined,
    messages: string[],
    meta?: {
      parentRunId?: string;
      subagent?: string;
      sequence?: number;
      agent?: string;
    },
  ) => {
    const task = tasks.find((t) => t.id === input.taskId);
    if (!task) return;
    const ts = tick();
    const turns = transcripts.get(task.id) ?? [];
    const turn: TaskTurn = {
      runId: run?.runId ?? `run_${counter++}`,
      sequence: meta?.sequence ?? turns.length + 1,
      ts,
      prompt: input.prompt,
      messages,
      stream: run?.stream,
      status,
      code: run?.code ?? [],
      outputs: run?.outputs ?? [],
      ...meta,
    };
    turns.push(turn);
    turns.sort((a, b) => a.sequence - b.sequence);
    transcripts.set(task.id, turns);
    task.runCount = turns.length;
    task.updatedTs = ts;
    // Concurrent turns can finish out of order. The roll-up describes the
    // latest transcript turn, not whichever promise happened to settle last.
    const newest = turns[turns.length - 1]!;
    task.lastRunStatus = newest.status;
    // Which agent the Task is on is the same kind of roll-up, read off the
    // same turn: the newest one is where the next turn has to go. A turn that
    // named none leaves the Task naming none rather than keeping an older
    // turn's answer, which would say the Task is on an agent it is not.
    if (newest.agent === undefined) delete task.agent;
    else task.agent = newest.agent;
  };

  // Replay the seeded transcripts turn by turn. Going through `appendTurn` is
  // what makes a seeded transcript indistinguishable from a run one — the
  // Task's roll-up fields are stamped by the replay rather than carried in
  // the seed, so there is one way for them to be set and only one.
  for (const seeded of seed.transcripts) {
    // `researchId` is along for the ride: `appendTurn` takes a whole
    // `StartRunInput` on the run path and reads only the task id, since the
    // Task already knows which Research it sits in. The replay passes the Task's
    // own Research so the two paths hand it the same thing.
    const researchId = tasks.find((t) => t.id === seeded.taskId)?.researchId ?? "";
    for (const turn of seeded.turns) {
      appendTurn(
        { researchId, taskId: seeded.taskId, prompt: turn.prompt },
        turn.status ?? "ok",
        undefined,
        turn.messages,
        // The same agent the run path names when no lab named one. A seeded
        // turn that carried no agent would be the one turn in the store whose
        // Task could not say what it had been talking to.
        { agent: SIMULATED_AGENT },
      );
    }
  }

  const severityOrder: Record<Finding["severity"], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  const sortedFindings = (taskId: string): Finding[] =>
    (findings[taskId] ?? [])
      .slice()
      .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  function apiFor(me: string): LykeionApi {
    // Every membership method below opens with this. Kept as one function
    // rather than four copies of the same check, so the message a caller
    // sees cannot drift between them.
    function requireOwner(): void {
      const mine = members.find((m) => m.user.id === me);
      if (!mine || mine.role !== "owner")
        throw new LykeionError("forbidden", "only an owner may manage this lab's membership");
    }
    return {
    async coreInfo() {
      return { name: "lykeion-core", version: "0.1.0" };
    },
    async listResearches(options?: { includeArchived?: boolean }) {
      const visible = options?.includeArchived
        ? researches
        : researches.filter((s) => s.archivedTs === undefined);
      return clone(visible).sort((a, b) => b.createdTs - a.createdTs);
    },
    async getResearch(researchId) {
      const research = researches.find((s) => s.id === researchId);
      if (!research) throw new LykeionError("not-found", `no such research: ${researchId}`);
      const forResearch = tasks
        .filter((t) => t.researchId === researchId)
        .sort((a, b) => a.number - b.number);
      return clone<ResearchDetail>({ research, tasks: forResearch });
    },
    async createResearch(input: NewResearch) {
      // Held to the same rule an edit is held to. A Research whose title is
      // blank is unfindable in every list that renders one, and nothing
      // downstream can recover the name its author meant to give it.
      const title = input.title.trim();
      if (!title) throw new LykeionError("invalid", "research title must not be empty");
      const now = tick();
      const research: Research = {
        id: nextId("s"),
        key: input.key,
        title,
        description: input.description,
        agentContext: input.agentContext,
        createdBy: me,
        createdTs: now,
        updatedTs: now,
      };
      researches.push(research);
      return clone(research);
    },
    async updateResearch(researchId, patch) {
      // A blank title is rejected, and the key is never touched. Blank agent
      // context is not an error — it is how the Research says it has none.
      const research = researches.find((s) => s.id === researchId);
      if (!research) throw new LykeionError("not-found", `no such research: ${researchId}`);
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) throw new LykeionError("invalid", "research title must not be empty");
        research.title = title;
      }
      if (patch.description !== undefined) research.description = patch.description;
      if (patch.agentContext !== undefined)
        research.agentContext = patch.agentContext;
      // Unpinning drops the key rather than storing a false: "not pinned" is
      // one state on the contract, and the server answers it the same way.
      if (patch.pinned !== undefined) {
        if (patch.pinned) research.pinned = true;
        else delete research.pinned;
      }
      research.updatedTs = tick();
      return clone(research);
    },
    async archiveResearch(researchId: string): Promise<Research> {
      const research = researches.find((s) => s.id === researchId);
      if (!research) throw new LykeionError("not-found", `no such research: ${researchId}`);
      research.archivedTs = tick();
      return clone(research);
    },
    async restoreResearch(researchId: string): Promise<Research> {
      const research = researches.find((s) => s.id === researchId);
      if (!research) throw new LykeionError("not-found", `no such research: ${researchId}`);
      delete research.archivedTs;
      return clone(research);
    },
    async deleteResearch(researchId) {
      // Deleting a Research removes it from the registry, taking everything its
      // directory held with it: nothing is set aside, and nothing about it is
      // recoverable from inside the workbench. Archive is the reversible
      // operation.
      const at = researches.findIndex((s) => s.id === researchId);
      if (at === -1) throw new LykeionError("not-found", `no such research: ${researchId}`);
      researches.splice(at, 1);
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (tasks[i].researchId === researchId) {
          // The Reviewer's findings and the Task's transcript both hang off
          // the task, not the Research, so they have to go while the task is
          // still here to name them.
          delete findings[tasks[i].id];
          transcripts.delete(tasks[i].id);
          tasks.splice(i, 1);
        }
      }
      dropConversations((c) => c.researchId === researchId);
    },
    async createTask(input: NewTask) {
      const title = input.title.trim();
      if (!title) throw new LykeionError("invalid", "task title must not be empty");
      // Refused rather than filed into nothing: a Task written against a
      // Research that does not exist would be created unfiled, and its author
      // would have no way to tell that from having asked for that.
      if (input.researchId !== undefined && !researches.some((s) => s.id === input.researchId))
        throw new LykeionError("not-found", `no such research: ${input.researchId}`);
      // Filed Tasks number within their Research; unfiled ones share one Lab-wide
      // run, so `TSK-1`, `TSK-2`… stay distinct from each other rather than
      // colliding on every Research's `1`.
      const n =
        tasks
          .filter((t) => t.researchId === input.researchId)
          .reduce((max, t) => Math.max(max, t.number), 0) + 1;
      const now = tick();
      const task: Task = {
        id: nextId("t"),
        number: n,
        researchId: input.researchId,
        stage: input.stage,
        title,
        description: input.description,
        status: "todo",
        priority: input.priority ?? "none",
        assignees: input.assignees?.length ? [...input.assignees] : undefined,
        createdBy: me,
        runCount: 0,
        createdTs: now,
        updatedTs: now,
      };
      tasks.push(task);
      return clone(task);
    },
    async updateTask(taskId, patch: TaskPatch) {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) throw new LykeionError("not-found", `no such task: ${taskId}`);
      // The light Done-gate: a Task cannot reach Done while a high-severity
      // Reviewer finding is unresolved.
      if (patch.status === "done") {
        const open = (findings[taskId] ?? []).filter(
          (f) => f.severity === "high" && !f.resolved,
        ).length;
        if (open > 0) {
          throw new LykeionError(
            "invalid",
            `cannot mark Done: ${open} unresolved high-severity Reviewer finding(s)`,
          );
        }
      }
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) throw new LykeionError("invalid", "task title must not be empty");
        task.title = title;
      }
      // Unpinning removes the flag rather than storing a false: the contract
      // carries `pinned` as optional, and "not pinned" is one state, not two.
      if (patch.pinned !== undefined) task.pinned = patch.pinned || undefined;
      if (patch.description !== undefined) task.description = patch.description;
      // Filing keeps the Task's number, which is cheaper than renumbering and
      // costs only that its code changes with it ("TSK-7" → "CMP-7").
      if (patch.researchId !== undefined) {
        if (!researches.some((s) => s.id === patch.researchId))
          throw new LykeionError("not-found", `no such research: ${patch.researchId}`);
        task.researchId = patch.researchId;
      }
      if (patch.stage !== undefined) task.stage = patch.stage;
      if (patch.status !== undefined) task.status = patch.status;
      if (patch.priority !== undefined) task.priority = patch.priority;
      if (patch.assignees !== undefined)
        task.assignees = patch.assignees.length
          ? [...patch.assignees]
          : undefined;
      if (patch.targetDate !== undefined)
        task.targetDate = patch.targetDate ?? undefined;
      if (patch.labels !== undefined)
        task.labels = patch.labels.length ? [...patch.labels] : undefined;
      if (patch.links !== undefined)
        task.links = patch.links.length ? [...patch.links] : undefined;
      if (patch.subtasks !== undefined)
        task.subtasks = patch.subtasks.length
          ? patch.subtasks.map((s) => ({ ...s }))
          : undefined;
      task.updatedTs = tick();
      return clone(task);
    },
    async deleteTask(taskId) {
      // An id nobody holds a Task for is an error, not a quiet success: a
      // caller that deletes the wrong id deserves to hear about it, and every
      // other Task-addressed method already says so in these words.
      const i = tasks.findIndex((t) => t.id === taskId);
      if (i < 0) throw new LykeionError("not-found", `no such task: ${taskId}`);
      // A Task is its chat, so its transcript goes with it — there is no
      // conversation left over to reopen.
      transcripts.delete(taskId);
      tasks.splice(i, 1);
      delete findings[taskId];
      // The threads ABOUT this Task go too. A Conversation is named by the
      // work it discusses; one left pointing at a deleted Task would list
      // itself under a title nothing answers to.
      dropConversations((c) => c.taskId === taskId);
    },

    async listConversations() {
      const mine = conversations.filter((c) => isParticipant(c, me));
      return clone(
        mine
          .map((conversation) => summarize(conversation, me))
          .sort((a, b) => b.conversation.updatedTs - a.conversation.updatedTs),
      );
    },
    async getConversation(conversationId: string) {
      const conversation = findConversation(conversationId);
      return clone({
        conversation,
        messages: messages
          .filter((m) => m.conversationId === conversationId)
          .sort((a, b) => a.ts - b.ts),
      });
    },
    async createConversation(input: NewConversation) {
      const body = input.body.trim();
      // Refused, not stored empty: a thread's whole reason to exist is that
      // somebody said something, and a row with no last message would read as
      // a broken record rather than as a deliberate silence.
      if (!body)
        throw new LykeionError(
          "invalid",
          "a conversation must open with a message",
        );
      const research = researches.find((s) => s.id === input.researchId);
      if (!research)
        throw new LykeionError("not-found", `no such research: ${input.researchId}`);
      const task = tasks.find((t) => t.id === input.taskId);
      if (!task)
        throw new LykeionError("not-found", `no such task: ${input.taskId}`);
      // A thread about a Task filed somewhere else is not a thread about that
      // Research, and would list under a Research the work does not belong to.
      if (task.researchId !== input.researchId)
        throw new LykeionError(
          "invalid",
          `task ${task.id} is not in research ${input.researchId}`,
        );

      // The opener is in it whether or not they named themselves — a thread
      // you cannot read is not one you opened.
      const participants = [...input.participants];
      if (!participants.some((p) => p.kind === "user" && p.userId === me))
        participants.unshift({ kind: "user", userId: me });

      const now = tick();
      const conversation: Conversation = {
        id: nextId("c"),
        researchId: input.researchId,
        taskId: input.taskId,
        title: input.title?.trim() || task.title,
        participants,
        createdBy: me,
        createdTs: now,
        updatedTs: now,
      };
      conversations.push(conversation);
      messages.push({
        id: nextId("m"),
        conversationId: conversation.id,
        author: { kind: "user", userId: me },
        body,
        ts: now,
      });
      // Read up to their own opening message: nobody arrives at a thread they
      // just started with one unread waiting in it.
      readTs[conversation.id] = { [me]: now };
      return clone(conversation);
    },
    async postMessage(conversationId: string, body: string) {
      const conversation = findConversation(conversationId);
      const text = body.trim();
      if (!text)
        throw new LykeionError("invalid", "a message must not be empty");
      const now = tick();
      const message: Message = {
        id: nextId("m"),
        conversationId,
        author: { kind: "user", userId: me },
        body: text,
        ts: now,
      };
      messages.push(message);
      // The thread rises to the top of the list, which is the only reason
      // `updatedTs` exists separately from `createdTs`.
      conversation.updatedTs = now;
      readTs[conversationId] = { ...readTs[conversationId], [me]: now };
      return clone(message);
    },
    async markConversationRead(conversationId: string) {
      const conversation = findConversation(conversationId);
      // Marked to the LAST MESSAGE's stamp, not to now: a later clock reading
      // would also swallow anything posted between the read and this call.
      const last = messages
        .filter((m) => m.conversationId === conversationId)
        .reduce((max, m) => Math.max(max, m.ts), conversation.createdTs);
      readTs[conversationId] = { ...readTs[conversationId], [me]: last };
    },
    async listTasks(options?: { includeDone?: boolean }) {
      const visible = options?.includeDone
        ? tasks
        : tasks.filter((t) => t.status !== "done");
      // Filed first, then unfiled — each run of numbers stays contiguous
      // rather than interleaving two unrelated sequences.
      const rank = (t: Task) => (t.researchId === undefined ? 1 : 0);
      return clone(visible).sort(
        (a, b) => rank(a) - rank(b) || a.number - b.number,
      );
    },
    async myWork() {
      const isMine = (t: Task) =>
        (t.assignees ?? []).some((a) => a.kind === "user" && a.userId === me);
      return clone(
        tasks
          .filter((t) => isMine(t) && t.status !== "done")
          .sort((a, b) => a.number - b.number),
      );
    },
    async getTask(taskId) {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) throw new LykeionError("not-found", `no such task: ${taskId}`);
      return clone({ task, turns: transcripts.get(taskId) ?? [] });
    },
    async nameTask(input: NameTaskInput) {
      const task = tasks.find((t) => t.id === input.taskId);
      if (!task) throw new LykeionError("not-found", `no such task: ${input.taskId}`);
      // Every gate a real lab applies, applied here in the same order — this
      // core has no machine to ask, but it is the one the UI runs against on
      // its own, and a naming that skipped the gates here would let a screen
      // work in the browser and rename over an authored title in a real lab.
      if (!promptNeedsSummary(input.prompt)) return null;
      if (task.title !== titleFromPrompt(input.prompt)) return null;
      const title = cleanSummaryTitle(localSummary(input.prompt));
      if (title === null || title === task.title) return null;
      task.title = title;
      task.updatedTs = tick();
      return title;
    },
    async listMachines() {
      return [];
    },
    async kernelEnvList() {
      // The declaration is pure metadata — no filesystem or machine
      // involved — so unlike `kernelEnvSetup` this core answers it for
      // real rather than with a fixed empty list.
      return clone(kernelEnvs);
    },
    async kernelEnvCreate(input: KernelEnvCreateInput) {
      // Checked by VALUE against `MANAGER_FOR`'s own keys, not by trusting
      // the declared type — the same reason `declareEnvironment` does, and
      // for the same reason: a caller reaching this core through
      // `kernel_env_create` sends JSON no schema has validated, so
      // `Language` being a closed union does not make this branch
      // unreachable in practice, only in the type checker.
      const named = (input as { language?: unknown }).language;
      if (typeof named !== "string" || !(named in MANAGER_FOR)) {
        throw new LykeionError(
          "unsupported",
          `Lykeion builds Python and R environments — it has no provisioner for ${String(named)}.`,
        );
      }
      const manager = MANAGER_FOR[named as Language];
      // Refused in front of whoever typed it, in the same words a real lab
      // uses — see `BUILDABLE_NAME`. Before the conflict check rather than
      // after: a name that could never be built is not a better answer for
      // being unclaimed.
      if (!BUILDABLE_NAME.test(input.name)) {
        throw new LykeionError(
          "invalid",
          // Quoted, unlike the refusals around it: the names this turns away
          // are the ones whose spaces, slashes or emptiness are the whole
          // problem, and bare in a sentence they are invisible.
          `${JSON.stringify(input.name)} cannot be an environment name — use only letters, numbers, ` +
            "dashes and underscores, since each machine builds an environment into a folder of that name.",
        );
      }
      if (kernelEnvs.some((e) => e.name === input.name))
        throw new LykeionError(
          "conflict",
          `this lab already has an environment named ${input.name}`,
        );
      const declared: KernelEnvDeclaration = {
        name: input.name,
        language: input.language,
        manager,
        packages: input.packages,
        createdBy: me,
        createdTs: tick(),
        lockRevision: 0,
      };
      kernelEnvs.push(declared);
      return clone(declared);
    },
    async kernelEnvDelete(name: string) {
      const index = kernelEnvs.findIndex((e) => e.name === name);
      if (index === -1) throw new LykeionError("not-found", `no such environment: ${name}`);
      kernelEnvs.splice(index, 1);
    },
    async kernelEnvSetup(machineId: string) {
      // No `uv` and no filesystem in the browser core, and no machine ever
      // paired to it either: `listMachines` here always answers `[]`, so
      // any `machineId` a caller names is honestly one this core has never
      // heard of, precisely — not a vaguer "nothing is online" now that the
      // caller must name a specific machine.
      throw new LykeionError("not-found", `no such machine: ${machineId}`);
    },
    async kernelEnvReclaim(machineId: string) {
      // Same reasoning as `kernelEnvSetup`: no machine behind a browser
      // core, ever, so there is nothing named `machineId` to free.
      throw new LykeionError("not-found", `no such machine: ${machineId}`);
    },
    async listRunningKernels() {
      // No machine behind a browser core, so nothing is holding a kernel.
      // An empty list, not a refusal: "none running" is a real answer.
      return [];
    },
    async computeSnapshot() {
      // No machine behind a browser core, so nothing to report against.
      return [];
    },
    async taskNotebook(_taskId: string) {
      return [];
    },
    async kernelExecute(_kernelId: string, _code: string): Promise<{ cellId: string }> {
      throw new LykeionError(
        "unsupported",
        "the managed kernel isn't available in the browser",
      );
    },
    async kernelInterrupt(_kernelId: string) {
      // Nothing to interrupt without a kernel.
    },
    async kernelStop(_kernelId: string, _feedback?: string) {
      // Nothing to stop, and so nothing holding a cell for the feedback to
      // reach. A kernel that was never there has already ended, which is what
      // this asks for — unlike `kernelRestart`, which promises a fresh
      // namespace the browser core has no process to hold.
    },
    async kernelRestart(_kernelId: string) {
      throw new LykeionError(
        "unsupported",
        "the managed kernel isn't available in the browser",
      );
    },
    async listAgentClis() {
      // The browser core can't probe the machine or handshake an ACP
      // adapter — no CLIs are detected, and so none is ever session-ready.
      return [];
    },
    async pairMachine(_input: PairMachineInput) {
      // There is no lab behind the browser core for a daemon to be
      // vouched into — pairing needs a real workspace server to mint the
      // code and hold the machine's token.
      throw new LykeionError(
        "unsupported",
        "the browser core has no lab to pair a machine with — pairing needs a real workspace server.",
      );
    },
    async removeMachine(_machineId: string) {
      throw new LykeionError(
        "unsupported",
        "the browser core has no lab to remove a machine from — removing a machine needs a real workspace server.",
      );
    },
    async runHistory() {
      // Runs are ephemeral in the browser core — no persisted history yet.
      return [];
    },
    async startRun(input: StartRunInput) {
      // A Task may hold several turns at once: one being worked on and the
      // rest waiting behind it, so a researcher can say the next thing while
      // they are still thinking it. What is bounded is how far ahead they may
      // type — past that it is a runaway rather than a queue.
      const outstanding = [...activeRuns.values()].filter(
        (run) => run.taskId === input.taskId,
      ).length;
      if (outstanding >= MAX_TURNS_OUTSTANDING)
        throw new LykeionError(
          "conflict",
          `task ${input.taskId} already has ${outstanding} turns waiting, which is as far ahead as this lab lets you type`,
        );
      // A turn in flight IS the work in progress, whatever the Task said
      // before it started — which is also what reopens a Task after an
      // explicit Done. One rule rather than two: completion still preserves a
      // later Done written while a sibling was already running (see
      // `onComplete`), so Done is neither permanent nor lost.
      const startingTask = tasks.find((task) => task.id === input.taskId);
      if (startingTask && startingTask.status !== "in-progress") {
        startingTask.status = "in-progress";
        startingTask.updatedTs = tick();
      }
      const sequence = nextTurnSequence(input.taskId);
      // Resolved once, and read by both the live snapshot and the turn this
      // run eventually lands, so the two can never disagree about what ran.
      // A core with no lab behind it has no CLI to name, and "simulated" is
      // the honest name for what answered instead of one.
      const agent = input.options.agent ?? SIMULATED_AGENT;
      let handle: SimulatedRun;
      const onComplete = (
        status: "ok" | "failed",
        run: RunRecord | undefined,
        messages: string[],
      ) => {
        // A turn always lands in its Task's transcript; a successful one also
        // moves the Task on to In Review, since the work it recorded is now
        // waiting to be checked.
        if (status === "ok") {
          const task = tasks.find((t) => t.id === input.taskId);
          // A user may mark the Task Done after this run began while another
          // sibling is still live. That explicit write is newer authority
          // than this older completion and must not be regressed.
          if (task && task.status !== "done") {
            task.status = "in-review";
            task.updatedTs = tick();
          }
        }
        appendTurn(input, status, run, messages, { sequence, agent });
        activeRuns.delete(handle.runId);
      };
      let active: {
        taskId: string;
        ownerId: string;
        handle: SimulatedRun;
        source: SimulatedRun;
        snapshot: ActiveRunSnapshot;
      };
      let terminal = false;
      const simulated = simulateRun(input, onComplete, (frame) => {
        const previous = active.snapshot;
        const event = frame.event;
        let stream = previous.stream;
        let state = previous.state;
        let plan = previous.plan;
        let live = previous.live;
        let reviewing = previous.reviewing;
        switch (event.event) {
          case "snapshot":
            active.snapshot = clone(event.snapshot);
            return;
          case "state":
            state = event.state;
            if (
              event.state.state === "awaiting-plan-approval" ||
              event.state.state === "executing" ||
              event.state.state === "awaiting-permission" ||
              event.state.state === "awaiting-question"
            ) plan = event.state.plan;
            break;
          case "assistant-text": {
            stream = clone(stream);
            const last = stream[stream.length - 1];
            if (event.partial && last?.kind === "text") last.text += event.text;
            else stream.push({ kind: "text", text: event.text });
            break;
          }
          case "plan-proposed":
            plan = event.plan;
            break;
          case "permission-card":
            state = {
              state: "awaiting-permission",
              ...(plan === undefined ? {} : { plan }),
              request: event.request,
            };
            break;
          case "question-asked":
            state = {
              state: "awaiting-question",
              ...(plan === undefined ? {} : { plan }),
              request: event.request,
            };
            break;
          case "log-entry": {
            stream = clone(stream);
            const existing = stream.findIndex(
              (item) => item.kind === "step" && item.entry.toolUseId === event.entry.toolUseId,
            );
            const item: TurnItem = { kind: "step", entry: event.entry };
            if (existing === -1) stream.push(item);
            else stream[existing] = item;
            break;
          }
          case "live":
            live = event.live;
            break;
          case "reviewing":
            reviewing = true;
            break;
          case "completed":
            terminal = true;
            state = event.state;
            live = {};
            reviewing = false;
            break;
        }
        active.snapshot = {
          ...previous,
          state,
          ...(plan === undefined ? {} : { plan }),
          stream,
          live,
          reviewing,
          lastEventSeq: frame.seq,
        };
      });
      const subscriptions = new Set<() => void>();
      const ownSubscription = (unsubscribe: () => void): (() => void) => {
        let subscribed = true;
        const release = () => {
          if (!subscribed) return;
          subscribed = false;
          subscriptions.delete(release);
          unsubscribe();
        };
        subscriptions.add(release);
        return release;
      };
      const detach = () => {
        for (const unsubscribe of subscriptions) unsubscribe();
        subscriptions.clear();
      };
      let closed = false;
      handle = {
        runId: simulated.runId,
        onEvent(cb) {
          if (closed) return () => {};
          // Fresh HTTP streams and resumed handles both establish authority
          // with a snapshot before incremental events. Keep the browser core
          // on that same contract: UI code must never invent a durable turn
          // sequence merely because this implementation is in-process.
          const unsubscribe = ownSubscription(simulated.onEvent(cb));
          cb({ event: "snapshot", snapshot: clone(active.snapshot) });
          return unsubscribe;
        },
        onEventFrom(cursor, cb) {
          if (closed) return () => {};
          return ownSubscription(simulated.onEventFrom(cursor, cb));
        },
        onFrameFrom(cursor, cb) {
          if (closed) return () => {};
          return ownSubscription(simulated.onFrameFrom(cursor, cb));
        },
        submit(decision) {
          if (closed || terminal) return;
          simulated.submit(decision);
        },
        detach() {
          detach();
        },
        close() {
          if (closed) return;
          closed = true;
          // Closing this handle cancels the shared run, but it owns only its
          // own observers. A resumed sibling must remain attached long enough
          // to receive the resulting terminal cancellation.
          detach();
          if (!terminal) simulated.submit({ action: "cancel" });
        },
      };
      active = {
        taskId: input.taskId,
        ownerId: me,
        handle,
        source: simulated,
        snapshot: {
          runId: handle.runId,
          sequence,
          prompt: input.prompt,
          agent,
          state: { state: "planning" },
          stream: [],
          live: {},
          reviewing: false,
          lastEventSeq: 0,
        },
      };
      runs.set(handle.runId, handle);
      runStarters.set(handle.runId, me);
      activeRuns.set(handle.runId, active);
      return handle;
    },
    async resumeRuns(taskId: string) {
      return [...activeRuns.values()]
        .filter((run) => run.taskId === taskId && run.ownerId === me)
        .sort((a, b) => a.snapshot.sequence - b.snapshot.sequence)
        .map((run) => {
          const snapshot = clone(run.snapshot);
          const subscriptions = new Set<() => void>();
          let cursor = snapshot.lastEventSeq;
          let terminal = false;
          let closed = false;
          const detach = () => {
            for (const unsubscribe of subscriptions) unsubscribe();
            subscriptions.clear();
          };
          return {
            runId: run.handle.runId,
            snapshot,
            onEvent(cb: (event: RunEvent) => void) {
              if (closed) return () => {};
              let subscribed = true;
              let unsubscribe: (() => void) | undefined;
              const release = () => {
                if (!subscribed) return;
                subscribed = false;
                subscriptions.delete(release);
                unsubscribe?.();
              };
              // Register ownership before asking the source to replay. Its
              // replay is synchronous, so a callback may detach/close before
              // `onFrameFrom` returns its inner unsubscribe.
              subscriptions.add(release);
              try {
                unsubscribe = run.source.onFrameFrom(cursor, (frame) => {
                  if (!subscribed || closed) return;
                  cursor = Math.max(cursor, frame.seq);
                  if (frame.event.event === "completed") terminal = true;
                  cb(frame.event);
                });
              } catch (error) {
                release();
                throw error;
              }
              // A detach during replay could not call an unsubscribe that did
              // not exist yet. Tear down the source immediately now that it
              // does, so later live frames cannot resurrect this observer.
              if (!subscribed) unsubscribe();
              return release;
            },
            submit(decision: RunDecision) {
              if (closed || terminal) return;
              run.source.submit(decision);
            },
            detach,
            close() {
              if (closed) return;
              closed = true;
              detach();
              if (!terminal) run.source.submit({ action: "cancel" });
            },
          };
        });
    },
    async revertTurn(runId: string) {
      if (runStarters.get(runId) !== me)
        throw new LykeionError("forbidden", `run ${runId} does not belong to you`);
      const taskId = [...transcripts.entries()].find(([, turns]) =>
        turns.some((turn) => turn.runId === runId),
      )?.[0];
      if (taskId === undefined) throw new LykeionError("not-found", `no such run: ${runId}`);
      const turns = transcripts.get(taskId)!;
      if (turns[turns.length - 1]?.runId !== runId)
        throw new LykeionError("conflict", "only the newest turn of a Task can be discarded");
      if (turns[turns.length - 1]?.revert?.available !== true)
        throw new LykeionError(
          "conflict",
          "there is no snapshot of this Task's files from before this turn, so nothing can be restored",
        );
      turns.pop();
      transcripts.set(taskId, turns);
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        task.runCount = turns.length;
        task.updatedTs = tick();
        task.lastRunStatus = turns[turns.length - 1]?.status;
      }
    },

    async submitRunDecision(runId: string, decision: RunDecision) {
      // One check, not two: an id nobody holds a run for and an id whose run
      // belongs to somebody else answer identically — a lab-mate must not
      // learn which is true from the difference (run ids are sequential and
      // guessable), the same reasoning the workspace server's own check is
      // held to.
      if (runStarters.get(runId) !== me)
        throw new LykeionError("forbidden", `run ${runId} does not belong to you`);
      // Refused by name here, on the way in, rather than narrowed to
      // something the researcher did not ask for: a "global" scope means
      // every Research this lab holds, and there is nothing this core could
      // grant that would honestly mean that.
      if (
        decision.action === "permission" &&
        decision.decision.decision === "allow" &&
        decision.decision.scope === "global"
      )
        throw new LykeionError(
          "invalid",
          `a "global" grant would reach every Research in this lab — grant one Research at a time instead`,
        );
      runs.get(runId)!.submit(decision);
    },
    async delegateSubagent(input: DelegateSubagentInput) {
      const sequence = nextTurnSequence(input.taskId);
      const runInput: StartRunInput = {
        researchId: input.researchId,
        taskId: input.taskId,
        prompt: input.task,
        options: input.options,
      };
      let handle: SimulatedRun;
      const onComplete = (
        status: "ok" | "failed",
        run: RunRecord | undefined,
        messages: string[],
      ) => {
        // A subagent turn is not a Task of its own — append it to the parent
        // Task's transcript, tagged with the parent run + persona so that
        // transcript can nest it. The Task's own status is left alone: the
        // delegated turn is a step inside the parent's turn, not work landing.
        appendTurn(runInput, status, run, messages, {
          parentRunId: input.parentRunId,
          subagent: input.persona.name,
          sequence,
          agent: input.options.agent ?? SIMULATED_AGENT,
        });
        delegatedSequences.delete(handle.runId);
      };
      handle = simulateRun(runInput, onComplete);
      delegatedSequences.set(handle.runId, { taskId: input.taskId, sequence });
      runs.set(handle.runId, handle);
      runStarters.set(handle.runId, me);
      return handle;
    },
    async readArtifact(_researchId, path) {
      const seeded = artifacts[path];
      if (seeded) return clone(seeded);
      // Not seeded — synthesize a small text blob so a viewer is always
      // reachable and nothing throws.
      return {
        path,
        contentType: inferContentType(path),
        encoding: "utf8",
        data: `# ${path}\n\nNo seeded fixture for this path — synthesized placeholder.\n`,
      };
    },
    async reviewFindings(_researchId, taskId) {
      return clone(sortedFindings(taskId));
    },
    async resolveFinding(_researchId, taskId, findingId) {
      const list = findings[taskId] ?? [];
      const hit = list.find((f) => f.id === findingId);
      if (!hit) throw new LykeionError("not-found", `no such finding: ${findingId}`);
      hit.resolved = true;
      return clone(sortedFindings(taskId));
    },

    // ---- customization engine ----

    async listSkills() {
      return clone(skills.slice().sort((a, b) => a.name.localeCompare(b.name)));
    },
    async createSkill(skill: Skill) {
      const entry: SkillEntry = { ...clone(skill), enabled: true };
      const at = skills.findIndex((s) => s.name === entry.name);
      if (at >= 0) skills[at] = entry;
      else skills.push(entry);
    },
    async setSkillEnabled(name: string, enabled: boolean) {
      const skill = skills.find((s) => s.name === name);
      if (!skill) throw new LykeionError("not-found", `no such skill: ${name}`);
      skill.enabled = enabled;
    },

    async listAgents() {
      return clone(agents.slice().sort((a, b) => a.name.localeCompare(b.name)));
    },
    async upsertAgent(agent: Agent) {
      const next = clone(agent);
      const at = agents.findIndex((a) => a.name === next.name);
      if (at >= 0) agents[at] = next;
      else agents.push(next);
    },

    async listConnectors() {
      return clone(
        connectors.slice().sort((a, b) => a.name.localeCompare(b.name)),
      );
    },
    async addConnector(connector: Connector) {
      const next = clone(connector);
      const at = connectors.findIndex((c) => c.name === next.name);
      if (at >= 0) connectors[at] = next;
      else connectors.push(next);
    },
    async setConnectorEnabled(name: string, enabled: boolean) {
      const connector = connectors.find((c) => c.name === name);
      if (!connector) throw new LykeionError("not-found", `no such connector: ${name}`);
      connector.enabled = enabled;
    },
    async setConnectorSkipApprovals(name: string, skip: boolean) {
      const connector = connectors.find((c) => c.name === name);
      if (!connector) throw new LykeionError("not-found", `no such connector: ${name}`);
      connector.skipApprovals = skip;
    },
    async connectorCatalog() {
      return curatedCatalog();
    },
    async listConnectorTools(name: string) {
      const connector = connectors.find((c) => c.name === name);
      if (!connector) throw new LykeionError("not-found", `no such connector: ${name}`);
      // There is no real MCP server behind the in-memory API to discover
      // against, so a small canned list keeps the Settings tools preview
      // exercisable in the browser surface and in tests.
      const tools: McpTool[] = [
        {
          name: "search",
          description: `Search ${connector.name}.`,
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ];
      return clone(tools);
    },

    // ---- groups ----

    async listGroups() {
      return clone(
        groups.slice().sort((a, b) => b.updatedTs - a.updatedTs),
      );
    },
    async createGroup(input: NewGroup) {
      const now = tick();
      const group: Group = {
        id: nextId("rg"),
        name: input.name,
        description: input.description ?? "",
        leadAgent: input.leadAgent,
        memberAgents: input.memberAgents ? [...input.memberAgents] : [],
        memberUsers: input.memberUsers ? [...input.memberUsers] : [],
        createdTs: now,
        updatedTs: now,
      };
      groups.push(group);
      return clone(group);
    },

    // ---- account ----

    async currentUser(): Promise<User> {
      const mine = members.find((m) => m.user.id === me);
      if (!mine) throw new LykeionError("not-found", `no member for the current user "${me}"`);
      return clone(mine.user);
    },

    async setAvatar(dataUrl: string | null): Promise<void> {
      const mine = members.find((m) => m.user.id === me);
      if (!mine) throw new LykeionError("not-found", `no member for the current user "${me}"`);
      // Written onto the member's own `User`, which is the same record
      // `listMembers` hands out — a picture kept beside the roster instead of
      // on it is a picture the roster renders without.
      if (dataUrl === null) delete mine.user.avatarUrl;
      else {
        assertAvatarDataUrl(dataUrl);
        mine.user.avatarUrl = dataUrl;
      }
    },

    async listMembers(): Promise<Member[]> {
      return clone(members).sort((a, b) => a.joinedTs - b.joinedTs);
    },

    async createInvite(role: Role): Promise<Invite> {
      requireOwner();
      const createdTs = tick();
      const invite: Invite = {
        code: nextId("inv"),
        role,
        createdBy: me,
        createdTs,
        // A week past minting, on the same monotonic base as every other
        // stamp here — a lapse time, not a span.
        expiresTs: createdTs + 7 * 24 * 60 * 60,
      };
      invites.push(invite);
      return clone(invite);
    },

    async listInvites(): Promise<Invite[]> {
      requireOwner();
      return clone(invites);
    },

    async revokeInvite(code: string): Promise<void> {
      requireOwner();
      const at = invites.findIndex((i) => i.code === code);
      if (at >= 0) invites.splice(at, 1);
    },

    async removeMember(userId: string): Promise<void> {
      requireOwner();
      const member = members.find((m) => m.user.id === userId);
      if (!member) throw new LykeionError("not-found", `no member "${userId}"`);
      if (member.role === "owner")
        throw new LykeionError("forbidden", "the owner cannot be offboarded");
      // Soft: the row stays so their authored records keep a name.
      member.removedTs = tick();
    },

    // ---- usage & settings ----

    async usage(): Promise<Usage> {
      return { series: [], agents: [], users: [] };
    },
    async getSettings(): Promise<WorkspaceSettings> {
      return {
        defaultModel: "",
        reasoningEffort: "",
        subagentModel: "",
        reviewerModel: "",
        useIntent: "",
        dataLocation: "~/lykeion",
        orgName: "",
        orgId: "",
        theme: themes.get(me) ?? "midnight",
      };
    },
    async setTheme(next: string): Promise<void> {
      themes.set(me, next);
    },
    };
  }

  return {
    api: (userId) => apiFor(userId ?? seed.me),
    // Getters, not values computed up front: `createInMemoryApi` builds a
    // lab on every call, including from seeds — `emptySeed()` among them —
    // that never gained a second member. Reading `ownerId`/`memberId` is
    // then the caller's business; a lab nobody asks a role of should not
    // have to have one to construct.
    get ownerId() {
      return members.find((m) => m.role === "owner")!.user.id;
    },
    get memberId() {
      return members.find((m) => m.role === "member")!.user.id;
    },
  };
}

/** Construct an in-memory API over a seed (defaults to [`defaultSeed`]). */
export function createInMemoryApi(
  seed: Seed = defaultSeed(),
  options?: InMemoryApiOptions,
): LykeionApi {
  return createInMemoryLab(seed, options).api();
}

/**
 * A scripted run for the browser/dev/tests: plan → (approve) → permission
 * card → (allow) → one gated Write → an artifact + a completed run. Driven by
 * the decisions submitted through the `RunHandle`, so the live Task surface is
 * fully interactive without a backend.
 */
let simRunSeq = 0;

function simulateRun(
  input: StartRunInput,
  onComplete: (
    status: "ok" | "failed",
    run: RunRecord | undefined,
    messages: string[],
  ) => void,
  onFrame?: (frame: RunEventFrame) => void,
): SimulatedRun {
  const runId = `run-sim-${input.taskId}-${simRunSeq++}`;
  const subs = new Set<(frame: RunEventFrame) => void>();
  const frames: RunEventFrame[] = [];
  const emit = (e: RunEvent) => {
    const frame = { seq: frames.length + 1, event: e };
    frames.push(frame);
    onFrame?.(frame);
    for (const cb of subs) cb(frame);
  };
  // Assistant prose is collected so a reopened Task can render its replies.
  const messages: string[] = [];
  // Prose and tool steps, interleaved in the order they actually occur here.
  const stream: TurnItem[] = [];
  /**
   * One WHOLE assistant message: the run's own contract guarantees it
   * (partial fragments are reassembled before being recorded), so a
   * simulated turn must never push a half-message item here — a consumer of
   * `stream`/`messages` is entitled to treat every text item as a complete
   * message.
   */
  const say = (text: string) => {
    messages.push(text);
    stream.push({ kind: "text", text });
    emit({ event: "assistant-text", text, partial: false });
  };
  const step = (entry: ExecutionLogEntry) => {
    stream.push({ kind: "step", entry });
    emit({ event: "log-entry", entry });
  };
  /**
   * A snapshot of the in-flight channels. REPLACES its predecessor — the
   * consumer keeps only the latest.
   */
  const live = (payload: import("./run").LiveTurn) =>
    emit({ event: "live", live: payload });
  /**
   * The idle snapshot: every `LiveTurn` field is skipped when empty, so an
   * idle snapshot serializes to `{}` — the exact payload that tells the UI
   * nothing is in flight anymore. Emitted right before the turn ends, on
   * every path (approved, rejected, denied, cancelled): a real turn always
   * leaves its in-flight channels empty by the time it completes.
   */
  const liveIdle = () => live({});
  let pending: ((d: RunDecision) => void) | null = null;
  // Decisions may arrive before the driver is awaiting (a test may submit
  // synchronously inside the event callback); queue them so none is lost.
  const queued: RunDecision[] = [];
  const waitDecision = () =>
    new Promise<RunDecision>((res) => {
      const early = queued.shift();
      if (early) res(early);
      else pending = res;
    });
  let closed = false;

  const plan: Plan = {
    steps: [
      { title: "Load the dataset", done: false },
      { title: "Write results", done: false },
    ],
    raw: "1. Load the dataset\n2. Write results/out.csv",
  };
  const request: PermissionRequest = {
    id: "perm-1",
    access: { kind: "write-path", target: "results/out.csv" },
    tool: "Write",
    detail: "Write results/out.csv",
  };
  /**
   * The raw tool input the CLI passes through on a `Write` — `file_path` is
   * the real `claude` key, and an Execution Log entry carries the input
   * verbatim, so the simulation must use the real key or the surface renders a
   * bare "Write" where a real run reads "Wrote results/out.csv".
   */
  const writeInput = { file_path: "results/out.csv" };

  /**
   * The UNGATED write the `claude` CLI performs in plan mode: it drafts the
   * plan into `~/.claude/plans/…` and only then calls `ExitPlanMode`. That
   * write is auto-allowed by the CLI itself — no `can_use_tool` request is
   * ever raised — so the seam cannot block it and first sees it in the tool
   * announcement (decision "ran"). That access left the workspace; the
   * simulation must reproduce that entry exactly, since it is the only way
   * any test can render the card that says so.
   */
  const planFileWriteStep: ExecutionLogEntry = {
    ts: 0,
    toolUseId: "tu-plan-file",
    tool: "Write",
    input: {
      file_path: "/Users/researcher/.claude/plans/load-the-dataset.md",
      content: "1. Load the dataset\n2. Write results/out.csv\n",
    },
    decision: "ran",
    isError: false,
    result:
      "File created successfully at: /Users/researcher/.claude/plans/load-the-dataset.md",
    outsideWorkspace: true,
  };

  /**
   * The run record a turn lands with. Every turn finalizes a record
   * unconditionally — denied, failed and cancelled turns are part of the
   * research record too — with status following the terminal state (Completed
   * → ok, a researcher's stop → cancelled, anything else → failed). A
   * failed or cancelled turn stamps no provenance, hence no outputs.
   * `stream` is snapshotted at the moment the turn ends.
   */
  const record = (
    status: "ok" | "failed" | "cancelled",
    wallMs: number,
    outputs: RunRecord["outputs"] = [],
  ): RunRecord => ({
    runId,
    ts: 0,
    command: input.prompt,
    status,
    wallMs,
    code: [],
    outputs,
    stream: [...stream],
    logHash: "d4c3b2a1",
  });

  async function drive() {
    // The per-message send mode. A plain send is a NORMAL run: no researcher-
    // facing plan gate, executing directly — it's treated as an
    // already-approved, step-less plan, so the approval machine still guards
    // every permission card. "Plan first" (planMode true) runs the plan →
    // approve → execute gate below.
    const planGate = input.options.planMode;
    // The plan carried through execution: the real multi-step plan in plan
    // mode, the empty synthesized one otherwise. `planOf` drops the empty plan,
    // so a normal run renders no plan card.
    const activePlan: Plan = planGate ? plan : { steps: [], raw: "" };

    // Mark a plan step's live status (plan-mode only); `done` tracks completion.
    const setStep = (i: number, status: StepStatus) => {
      const s = planGate ? plan.steps[i] : undefined;
      if (!s) return;
      s.status = status;
      s.done = status === "completed";
    };

    if (planGate) {
      emit({ event: "state", state: { state: "planning" } });
      // The prose channel opens before anything lands on the Execution Log —
      // mirrors how a real run streams partial assistant text as it arrives,
      // well before the first tool call is even announced.
      live({ text: "Here's my plan" });
      say("Here's my plan for this task.");
      // Before the plan gate, and never gated itself — see `planFileWriteStep`.
      step(planFileWriteStep);
      emit({ event: "plan-proposed", plan });
      emit({
        event: "state",
        state: { state: "awaiting-plan-approval", plan },
      });

      const d1 = await waitDecision();
      if (closed || d1.action === "cancel") {
        // A stop reached before anything was even proposed to decline is
        // still a stop, not a decline of anything — it lands `cancelled`,
        // never a `failed` with an invented reason. It still lands a run:
        // a cancelled turn is part of the research record too.
        const run = record("cancelled", 200);
        liveIdle();
        emit({ event: "completed", state: { state: "cancelled" }, run });
        onComplete("failed", run, messages);
        return;
      }
      if (d1.action !== "approve-plan") {
        const reason =
          d1.action === "reject-plan" ? (d1.reason ?? "plan rejected") : "plan rejected";
        // A soft failure still lands a run: the record carries the failed
        // state, not the absence of a record (only a hard, unrecoverable
        // error would complete with `run: undefined`).
        const run = record("failed", 200);
        liveIdle();
        emit({ event: "completed", state: { state: "failed", reason }, run });
        onComplete("failed", run, messages);
        return;
      }
    }

    emit({ event: "state", state: { state: "executing", plan: activePlan } });

    // A clarifying question mid-turn: the agent asks, the researcher picks (or
    // skips), the turn resumes. GATED on a prompt marker deliberately — the
    // canonical happy-path fixture (plan → permission → complete) that many
    // tests drive stays exactly as it was; send a prompt containing "clarify"
    // to exercise the question.
    if (input.prompt.toLowerCase().includes("clarif")) {
      const question: QuestionRequest = {
        requestId: "q-1",
        header: "Library",
        question: "Which CRISPR knockout library should the screen target?",
        options: [
          { label: "Brunello", description: "genome-wide, 4 sgRNAs/gene" },
          { label: "GeCKOv2", description: "broader coverage, 6 sgRNAs/gene" },
        ],
        multiSelect: false,
      };
      emit({ event: "question-asked", request: question });
      emit({
        event: "state",
        state: {
          state: "awaiting-question",
          plan: activePlan,
          request: question,
        },
      });
      const dq = await waitDecision();
      if (closed || dq.action === "cancel") {
        const run = record("cancelled", 500);
        liveIdle();
        emit({
          event: "completed",
          state: { state: "cancelled" },
          run,
        });
        onComplete("failed", run, messages);
        return;
      }
      const picked =
        dq.action === "answer-question" && dq.answer.selected.length > 0
          ? dq.answer.selected.join(", ")
          : "Brunello";
      say(`Using the ${picked} library.`);
      emit({ event: "state", state: { state: "executing", plan: activePlan } });
    }

    say("Running the analysis.");
    emit({ event: "permission-card", request });
    emit({
      event: "state",
      state: { state: "awaiting-permission", plan: activePlan, request },
    });

    const d2 = await waitDecision();
    if (closed || d2.action === "cancel") {
      // Cancel is the hard stop — nothing to resume. It still records the
      // run: a cancelled turn is part of the research record, landed with
      // status `cancelled` rather than `failed` — a stop is not a decline
      // of anything, so nothing here actually failed.
      //
      // …and it records the ABANDONED STEP too: it pushes an entry with
      // decision "cancelled" and its order slot — the stop is on the
      // Execution Log for the record — so the tool the researcher stopped is
      // in the transcript, visibly blocked, instead of vanishing from it. The
      // Write never ran: no result. `isError: true` even so — a live
      // adapter still reports its own follow-up for a call it never got to
      // finish, and that follow-up reads failed, whatever ended it.
      step({
        ts: 0,
        toolUseId: "tu-1",
        tool: "Write",
        input: writeInput,
        decision: "cancelled",
        isError: true,
      });
      const run = record("cancelled", 600);
      liveIdle();
      emit({
        event: "completed",
        state: { state: "cancelled" },
        run,
      });
      onComplete("failed", run, messages);
      return;
    }
    if (d2.action !== "permission" || d2.decision.decision !== "allow") {
      // A denial does NOT fail the turn: it's recorded in the Execution Log
      // and the turn resumes wherever it was interrupted (allow and deny both
      // resume; only cancel ends the turn).
      step({
        ts: 0,
        toolUseId: "tu-1",
        tool: "Write",
        // The tool input the CLI asked to run — not the permission `access`
        // envelope, which is a core-side shape the Execution Log never carries.
        input: writeInput,
        decision: "denied",
        isError: true,
        result: "Denied by the researcher",
      });
      emit({ event: "state", state: { state: "executing", plan: activePlan } });
      say(
        "Understood — I won't write results/out.csv. Wrapping up without it.",
      );

      const run = record("ok", 800);
      liveIdle();
      if (input.taskId) emit({ event: "reviewing" });
      emit({ event: "completed", state: { state: "completed" }, run });
      onComplete("ok", run, messages);
      return;
    }

    // Walk the plan step by step so the run strip sees a live current step:
    // step 0 in_progress → completed as step 1 becomes current → completed.
    setStep(0, "in_progress");
    emit({ event: "state", state: { state: "executing", plan: activePlan } });
    step({
      ts: 0,
      toolUseId: "tu-1",
      tool: "Write",
      input: writeInput,
      decision: "allowed-once",
      isError: false,
      result: "File created successfully at results/out.csv",
    });
    setStep(0, "completed");
    setStep(1, "in_progress");
    emit({ event: "state", state: { state: "executing", plan: activePlan } });
    say("Wrote results/out.csv — the run is complete.");
    setStep(1, "completed");

    const run = record("ok", 1200, [
      { path: "results/out.csv", hash: "a1b2c3d4", size: 24 },
    ]);
    liveIdle();
    // A clean task turn is checked by the Reviewer — surface that live phase.
    if (input.taskId) emit({ event: "reviewing" });
    emit({ event: "completed", state: { state: "completed" }, run });
    onComplete("ok", run, messages);
  }

  // A run's lifecycle belongs to the run, not to whether a browser currently
  // observes it. The next tick still lets the first subscriber attach before
  // scripted events begin, while detach can never keep the work from starting.
  setTimeout(() => {
    if (closed) {
      // `close()` can win before the deferred driver starts. That is still a
      // cancelled turn, not a run the active registry must retain forever.
      // The handle has already released its subscribers, so this terminal
      // bookkeeping lands durably without delivering into a closed observer.
      const run = record("cancelled", 0);
      liveIdle();
      emit({ event: "completed", state: { state: "cancelled" }, run });
      onComplete("failed", run, messages);
      return;
    }
    void drive();
  }, 0);

  return {
    runId,
    onEvent(cb) {
      const send = (frame: RunEventFrame) => cb(frame.event);
      subs.add(send);
      return () => subs.delete(send);
    },
    onEventFrom(cursor, cb) {
      for (const frame of frames) if (frame.seq > cursor) cb(frame.event);
      const send = (frame: RunEventFrame) => cb(frame.event);
      subs.add(send);
      return () => subs.delete(send);
    },
    onFrameFrom(cursor, cb) {
      for (const frame of frames) if (frame.seq > cursor) cb(frame);
      subs.add(cb);
      return () => subs.delete(cb);
    },
    submit(decision) {
      const resolve = pending;
      pending = null;
      if (resolve) resolve(decision);
      else queued.push(decision);
    },
    detach() {
      subs.clear();
    },
    close() {
      closed = true;
      const resolve = pending;
      pending = null;
      if (resolve) resolve({ action: "cancel" });
      subs.clear();
    },
  };
}
