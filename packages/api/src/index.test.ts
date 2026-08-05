import { describe, expect, it, vi } from "vitest";
import {
  artifactDataUrl,
  Commands,
  createInMemoryApi,
  createInMemoryLab,
  emptySeed,
  STAGES,
  taskCode,
  type Assignee,
  type CoreInfo,
  type Invite,
  type Member,
  type RunHandle,
  type User,
} from "./index";
import * as areaExports from "./conformance";
import { ALL_AREAS, runContractConformance } from "./conformance";

describe("UI ↔ core contract", () => {
  it("maps every command to its snake_case name", () => {
    expect(Commands.coreInfo).toBe("core_info");
    expect(Commands.resumeRuns).toBe("resume_runs");
    for (const name of Object.values(Commands)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("CoreInfo's shape is just name and version", () => {
    const sample: CoreInfo = { name: "lykeion-core", version: "0.1.0" };
    expect(Object.keys(sample).sort()).toEqual(["name", "version"]);
  });

  it("has the six scientific stages in order", () => {
    expect(STAGES).toEqual([
      "background",
      "hypothesis",
      "methods",
      "results",
      "future-directions",
      "conclusions",
    ]);
  });
});

describe("in-memory API", () => {
  it("lists seeded studies and their tasks", async () => {
    const api = createInMemoryApi();
    const studies = await api.listStudies();
    expect(studies.length).toBeGreaterThanOrEqual(5);

    const cmp = studies.find((s) => s.key === "CMP")!;
    const detail = await api.getStudy(cmp.id);
    expect(detail.tasks.length).toBeGreaterThan(0);
    expect(taskCode(detail.study, detail.tasks[0])).toMatch(/^CMP-\d+$/);
  });

  it("opens on a seeded thread with something genuinely unread in it", async () => {
    const api = createInMemoryApi();
    const list = await api.listConversations();
    // An agent is in the conversation, not just people — the seed has to
    // show that a thread holds both, because the surface is built for it.
    expect(
      list.some((c) =>
        c.conversation.participants.some((p) => p.kind === "agent"),
      ),
    ).toBe(true);
    expect(list.some((c) => c.unread > 0)).toBe(true);
    // Newest activity first.
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].conversation.updatedTs).toBeGreaterThanOrEqual(
        list[i].conversation.updatedTs,
      );
    }
  });

  it("a thread opened now outranks every seeded one", async () => {
    // The seed is stamped BELOW the instance clock's start on purpose. If it
    // were not, a thread a researcher just opened would sort under fixture
    // data and vanish off the bottom of their list.
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const [task] = (await api.getStudy(study.id)).tasks;
    const fresh = await api.createConversation({
      studyId: study.id,
      taskId: task.id,
      participants: [],
      body: "just now",
    });
    const list = await api.listConversations();
    expect(list[0].conversation.id).toBe(fresh.id);
  });
});

describe("live write clock (in-memory)", () => {
  it("stamps a live create at or after the real time the clock reports", async () => {
    // A reading shaped like a real `Date.now() / 1000`, well above the
    // fixture's T0 (2026-06-21) — a stamp that ignored the clock and fell
    // back to T0 would land below it, so this checks the actual
    // relationship: the stamp must sit at or after the time reported, not
    // merely differ from T0.
    const base = 2_000_000_000;
    const api = createInMemoryApi(emptySeed(), { now: () => base });
    const study = await api.createStudy({ title: "Live", key: "LIV" });
    expect(study.createdTs).toBeGreaterThanOrEqual(base);
  });

  it("stamps a write with the time it happened, not the time the instance was built", async () => {
    // An instance lives as long as the tab. Sampling the clock once at
    // construction would report anything created an hour later as an hour
    // old — the same defect as stamping the fixture date, just smaller, and
    // invisible to any test that creates immediately after constructing.
    let seconds = 2_000_000_000;
    const api = createInMemoryApi(emptySeed(), { now: () => seconds });
    await api.createStudy({ title: "At boot", key: "BOOT" });

    seconds += 3600;
    const later = await api.createStudy({ title: "An hour on", key: "HOUR" });
    expect(later.createdTs).toBeGreaterThanOrEqual(seconds);

    // Still strictly increasing when the clock does not move: two writes in
    // the same second must not tie, or recency ordering goes ambiguous.
    const a = await api.createStudy({ title: "Same second", key: "SAME" });
    const b = await api.createStudy({ title: "Also same", key: "ALSO" });
    expect(b.createdTs).toBeGreaterThan(a.createdTs);
  });

  it("is deterministic with no base passed — two fresh instances stamp the same creates identically", async () => {
    // Mock two wildly different real-clock readings across the two
    // constructions. If the default base were ever wired to `Date.now()`,
    // the instances would diverge by roughly the gap between the mocked
    // reads; comparing two un-mocked instances back to back could pass by
    // sheer timing luck even on a broken implementation, so the mock is
    // what makes this discriminating rather than inert.
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValueOnce(1_000_000_000_000);
      const studyA = await createInMemoryApi(emptySeed()).createStudy({
        title: "A",
        key: "AAA",
      });
      now.mockReturnValueOnce(9_000_000_000_000);
      const studyB = await createInMemoryApi(emptySeed()).createStudy({
        title: "B",
        key: "BBB",
      });

      expect(studyA.createdTs).toBe(studyB.createdTs);
    } finally {
      // Unconditional: a throw from the create or the assertion above must
      // not leave `Date.now` mocked for every test that runs after this one
      // in the file.
      now.mockRestore();
    }
  });
});

describe("Reviewer findings (in-memory)", () => {
  it("reviewFindings returns the seeded CMP-3 findings, severity-ordered", async () => {
    const api = createInMemoryApi();
    const findings = await api.reviewFindings("s_cmp", "t_3");
    expect(findings.length).toBeGreaterThanOrEqual(1);

    // The high value-contradicts-source finding leads (worst first).
    expect(findings[0].severity).toBe("high");
    expect(findings[0].class).toBe("value-contradicts-source");
    expect(findings[0].claim).toBe("The dataset contains 512 neurons.");
    expect(findings[0].evidence).toMatch(/384/);
    expect(findings[0].resolved).toBe(false);
    // High sorts ahead of any medium.
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i].severity === "high" ? 0 : 1).toBeGreaterThanOrEqual(0);
    }
  });

  it("resolveFinding flips resolved and returns the updated list", async () => {
    const api = createInMemoryApi();
    const before = await api.reviewFindings("s_cmp", "t_3");
    const high = before.find((f) => f.severity === "high")!;
    expect(high.resolved).toBe(false);

    const after = await api.resolveFinding("s_cmp", "t_3", high.id);
    expect(after.find((f) => f.id === high.id)!.resolved).toBe(true);
    // And it persists on the next read.
    const again = await api.reviewFindings("s_cmp", "t_3");
    expect(again.find((f) => f.id === high.id)!.resolved).toBe(true);
  });

  it("the Done-gate blocks while a high finding is open, then clears", async () => {
    const api = createInMemoryApi();
    // CMP-3 has an open high-severity finding → marking Done rejects.
    await expect(api.updateTask("t_3", { status: "done" })).rejects.toThrow(
      /unresolved high-severity/i,
    );

    // Resolve the high finding, then Done succeeds.
    const findings = await api.reviewFindings("s_cmp", "t_3");
    const high = findings.find((f) => f.severity === "high")!;
    await api.resolveFinding("s_cmp", "t_3", high.id);
    const updated = await api.updateTask("t_3", { status: "done" });
    expect(updated.status).toBe("done");
  });

  // Findings hang off a task id, so a deleted task used to leave its findings
  // behind — and the next task to be handed that id would inherit them. These
  // two pin the sweep. Asserted through `createTask`, which reuses the id
  // counter, rather than by reaching into the store.
  it("deleting a task takes its findings with it", async () => {
    const api = createInMemoryApi();
    expect((await api.reviewFindings("s_cmp", "t_3")).length).toBeGreaterThan(
      0,
    );

    await api.deleteTask("t_3");

    expect(await api.reviewFindings("s_cmp", "t_3")).toEqual([]);
  });

  it("deleting a Study takes its tasks' findings with it", async () => {
    const api = createInMemoryApi();
    expect((await api.reviewFindings("s_cmp", "t_3")).length).toBeGreaterThan(
      0,
    );

    await api.deleteStudy("s_cmp");

    expect(await api.reviewFindings("s_cmp", "t_3")).toEqual([]);
  });
});

describe("customization engine (in-memory)", () => {
  it("listSkills returns the seeded set with enabled and disabled skills", async () => {
    const api = createInMemoryApi();
    const skills = await api.listSkills();
    expect(skills.length).toBeGreaterThanOrEqual(2);
    expect(skills.some((s) => s.enabled)).toBe(true);
    expect(skills.some((s) => !s.enabled)).toBe(true);
    // Flat SkillEntry shape (no nested Skill).
    const rnaseq = skills.find((s) => s.name === "rnaseq")!;
    expect(rnaseq.description).toMatch(/differential-expression/i);
    expect(typeof rnaseq.body).toBe("string");
  });
});

describe("artifacts (in-memory)", () => {
  it("readArtifact serves the seeded CSV as utf8 text/csv", async () => {
    const api = createInMemoryApi();
    const blob = await api.readArtifact("s_cmp", "results/out.csv");
    expect(blob.contentType).toBe("text/csv");
    expect(blob.encoding).toBe("utf8");
    expect(blob.data).toMatch(/^neuron,orientation_deg/);
  });

  it("readArtifact serves the seeded PNG as base64 image/png", async () => {
    const api = createInMemoryApi();
    const blob = await api.readArtifact("s_cmp", "results/fig.png");
    expect(blob.contentType).toBe("image/png");
    expect(blob.encoding).toBe("base64");
    // Standard PNG signature, base64-encoded, starts "iVBORw0KG".
    expect(blob.data.startsWith("iVBORw0KG")).toBe(true);
  });

  it("readArtifact serves the seeded PDF as base64 application/pdf", async () => {
    const api = createInMemoryApi();
    const blob = await api.readArtifact("s_cmp", "results/report.pdf");
    expect(blob.contentType).toBe("application/pdf");
    expect(blob.encoding).toBe("base64");
    // "%PDF-" base64-encodes to "JVBERi".
    expect(blob.data.startsWith("JVBERi")).toBe(true);
  });

  it("readArtifact serves the seeded notebook as parseable nbformat-4 JSON", async () => {
    const api = createInMemoryApi();
    const blob = await api.readArtifact("s_cmp", "results/analysis.ipynb");
    expect(blob.contentType).toBe("application/x-ipynb+json");
    expect(blob.encoding).toBe("utf8");
    const nb = JSON.parse(blob.data) as {
      nbformat: number;
      cells: { cell_type: string }[];
    };
    expect(nb.nbformat).toBe(4);
    expect(nb.cells.map((c) => c.cell_type)).toEqual(["markdown", "code"]);
  });

  it("readArtifact synthesizes a text blob for an unseeded path", async () => {
    const api = createInMemoryApi();
    const blob = await api.readArtifact("s_cmp", "results/unknown.txt");
    expect(blob.encoding).toBe("utf8");
    expect(blob.contentType).toBe("text/plain");
    expect(blob.data.length).toBeGreaterThan(0);
  });

  it("artifactDataUrl encodes base64 and utf8 blobs", () => {
    expect(
      artifactDataUrl({
        path: "a.png",
        contentType: "image/png",
        encoding: "base64",
        data: "AAAA",
      }),
    ).toBe("data:image/png;base64,AAAA");

    const url = artifactDataUrl({
      path: "a.csv",
      contentType: "text/csv",
      encoding: "utf8",
      data: "x,y\n1,2\n",
    });
    expect(url.startsWith("data:text/csv;charset=utf-8,")).toBe(true);
    // Commas/newlines are percent-encoded so the URL survives intact.
    expect(url).toContain("%0A");
  });
});

describe("in-memory run simulation", () => {
  async function collect(
    approve: boolean,
    allow: boolean,
  ): Promise<import("./run").RunEvent[]> {
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const task = (await api.getStudy(study.id)).tasks[0];
    const session = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "run it",
      options: { planMode: true },
    });

    const events: import("./run").RunEvent[] = [];
    return new Promise((resolve) => {
      session.onEvent((e) => {
        events.push(e);
        if (e.event === "plan-proposed") {
          if (approve) session.submit({ action: "approve-plan" });
          else session.submit({ action: "reject-plan" });
        }
        if (e.event === "permission-card") {
          session.submit(
            allow
              ? {
                  action: "permission",
                  requestId: e.request.id,
                  decision: { decision: "allow", scope: "once" },
                }
              : {
                  action: "permission",
                  requestId: e.request.id,
                  decision: { decision: "deny" },
                },
          );
        }
        if (e.event === "completed") resolve(events);
      });
    });
  }

  it("starts every fresh handle with its authoritative run snapshot", async () => {
    vi.useFakeTimers();
    try {
      const api = createInMemoryApi();
      const [study] = await api.listStudies();
      const task = (await api.getStudy(study.id)).tasks[0];
      const handle = await api.startRun({
        studyId: study.id,
        taskId: task.id,
        prompt: "snapshot first",
        options: { planMode: false },
      });
      const events: import("./run").RunEvent[] = [];
      handle.onEvent((event) => events.push(event));

      expect(events[0]).toEqual({
        event: "snapshot",
        snapshot: expect.objectContaining({
          runId: handle.runId,
          prompt: "snapshot first",
          state: { state: "planning" },
          lastEventSeq: 0,
        }),
      });

      handle.close();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("plan → approve → allow yields a completed run with an artifact", async () => {
    const events = await collect(true, true);
    const done = events.find((e) => e.event === "completed");
    expect(done).toBeDefined();
    expect(done!.event === "completed" && done!.state.state).toBe("completed");
    const run = done!.event === "completed" ? done!.run : undefined;
    expect(run?.outputs.some((o) => o.path === "results/out.csv")).toBe(true);
    // A card was shown and an execution-log entry recorded.
    expect(events.some((e) => e.event === "permission-card")).toBe(true);
    expect(events.some((e) => e.event === "log-entry")).toBe(true);
  });

  it("detach is observer-only: an immediate detach can resubscribe and still complete", async () => {
    vi.useFakeTimers();
    try {
      const api = createInMemoryApi();
      const [study] = await api.listStudies();
      const task = (await api.getStudy(study.id)).tasks[0];
      const handle = await api.startRun({
        studyId: study.id,
        taskId: task.id,
        prompt: "run it",
        options: { planMode: false },
      });
      handle.detach();

      const events: import("./run").RunEvent[] = [];
      handle.onEvent((event) => {
        events.push(event);
        if (event.event === "permission-card") {
          handle.submit({
            action: "permission",
            requestId: event.request.id,
            decision: { decision: "allow", scope: "once" },
          });
        }
      });
      await vi.runAllTimersAsync();

      expect(events.some((event) => event.event === "permission-card")).toBe(true);
      expect(events.some((event) => event.event === "completed")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaching a fresh handle leaves an overlapping resumed observer attached", async () => {
    vi.useFakeTimers();
    try {
      const api = createInMemoryApi();
      const [study] = await api.listStudies();
      const task = (await api.getStudy(study.id)).tasks[0];
      const fresh = await api.startRun({
        studyId: study.id,
        taskId: task.id,
        prompt: "overlapping observers",
        options: { planMode: false },
      });
      const [resumed] = await api.resumeRuns(task.id);
      const events: import("./run").RunEvent[] = [];
      resumed.onEvent((event) => {
        events.push(event);
        if (event.event === "permission-card") {
          resumed.submit({
            action: "permission",
            requestId: event.request.id,
            decision: { decision: "allow", scope: "once" },
          });
        }
      });

      fresh.detach();
      await vi.runAllTimersAsync();

      expect(events.some((event) => event.event === "permission-card")).toBe(true);
      expect(events.some((event) => event.event === "completed")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing a fresh handle still delivers terminal cancellation to a resumed observer", async () => {
    vi.useFakeTimers();
    try {
      const api = createInMemoryApi();
      const [study] = await api.listStudies();
      const task = (await api.getStudy(study.id)).tasks[0];
      const fresh = await api.startRun({
        studyId: study.id,
        taskId: task.id,
        prompt: "shared cancellation",
        options: { planMode: false },
      });
      const [resumed] = await api.resumeRuns(task.id);
      const events: import("./run").RunEvent[] = [];
      resumed.onEvent((event) => events.push(event));

      fresh.close();
      fresh.close();
      const afterClose: import("./run").RunEvent[] = [];
      fresh.onEvent((event) => afterClose.push(event));
      await vi.runAllTimersAsync();

      expect(afterClose).toEqual([]);
      expect(events).toContainEqual({
        event: "completed",
        state: { state: "cancelled" },
        run: expect.objectContaining({ status: "cancelled" }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumed observers advance their cursor before detach and resubscribe", async () => {
    vi.useFakeTimers();
    try {
      const api = createInMemoryApi();
      const [study] = await api.listStudies();
      const task = (await api.getStudy(study.id)).tasks[0];
      const fresh = await api.startRun({
        studyId: study.id,
        taskId: task.id,
        prompt: "cursor ownership",
        options: { planMode: false },
      });
      const [resumed] = await api.resumeRuns(task.id);
      const first: import("./run").RunEvent[] = [];
      resumed.onEvent((event) => first.push(event));
      await vi.runAllTimersAsync();
      expect(first.some((event) => event.event === "permission-card")).toBe(true);

      resumed.detach();
      const replayed: import("./run").RunEvent[] = [];
      resumed.onEvent((event) => replayed.push(event));
      expect(replayed).toEqual([]);

      resumed.close();
      fresh.detach();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops synchronous replay when a resumed observer detaches from its first frame", async () => {
    vi.useFakeTimers();
    try {
      const api = createInMemoryApi();
      const [study] = await api.listStudies();
      const task = (await api.getStudy(study.id)).tasks[0];
      const fresh = await api.startRun({
        studyId: study.id,
        taskId: task.id,
        prompt: "detach during replay",
        options: { planMode: false },
      });
      const [resumed] = await api.resumeRuns(task.id);

      // Let the source buffer several frames while this resumed handle still
      // holds its original cursor, but before it owns an observer.
      await vi.advanceTimersByTimeAsync(0);

      const seen: import("./run").RunEvent[] = [];
      resumed.onEvent((event) => {
        seen.push(event);
        resumed.detach();
      });

      expect(seen).toHaveLength(1);
      fresh.close();
      await vi.runAllTimersAsync();
      expect(seen).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles concurrent turns in start sequence order when the second finishes first", async () => {
    const api = createInMemoryApi(emptySeed());
    const study = await api.createStudy({ title: "Concurrent", key: "CON" });
    const task = await api.createTask({
      studyId: study.id,
      stage: "methods",
      title: "keep turn order",
    });
    const first = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "first turn",
      options: { planMode: false },
    });
    const second = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "second turn",
      options: { planMode: false },
    });

    let secondRequestId = "";
    const completionOrder: string[] = [];
    let firstReady!: () => void;
    let secondReady!: () => void;
    let firstFinished!: () => void;
    let secondFinished!: () => void;
    const firstPermission = new Promise<void>((resolve) => (firstReady = resolve));
    const secondPermission = new Promise<void>((resolve) => (secondReady = resolve));
    const firstDone = new Promise<void>((resolve) => (firstFinished = resolve));
    const secondDone = new Promise<void>((resolve) => (secondFinished = resolve));

    first.onEvent((event) => {
      if (event.event === "permission-card") {
        firstReady();
      }
      if (event.event === "completed") {
        completionOrder.push("first turn");
        firstFinished();
      }
    });
    second.onEvent((event) => {
      if (event.event === "permission-card") {
        secondRequestId = event.request.id;
        secondReady();
      }
      if (event.event === "completed") {
        completionOrder.push("second turn");
        secondFinished();
      }
    });

    await Promise.all([firstPermission, secondPermission]);
    second.submit({
      action: "permission",
      requestId: secondRequestId,
      decision: { decision: "allow", scope: "once" },
    });
    await secondDone;
    first.submit({ action: "cancel" });
    await firstDone;

    expect(completionOrder).toEqual(["second turn", "first turn"]);
    const detail = await api.getTask(task.id);
    expect(
      detail.turns.map((turn) => ({
        prompt: turn.prompt,
        sequence: turn.sequence,
        status: turn.status,
      })),
    ).toEqual([
      { prompt: "first turn", sequence: 1, status: "failed" },
      { prompt: "second turn", sequence: 2, status: "ok" },
    ]);
    expect(detail.task.lastRunStatus).toBe("ok");
  });

  it("keeps an explicit Done written between sibling completions, then reopens for a new run", async () => {
    const api = createInMemoryApi(emptySeed());
    const study = await api.createStudy({ title: "Done race", key: "DONE" });
    const task = await api.createTask({
      studyId: study.id,
      stage: "methods",
      title: "preserve explicit done",
    });
    const first = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "first sibling",
      options: { planMode: false },
    });
    const second = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "second sibling",
      options: { planMode: false },
    });

    const permissionFor = (handle: RunHandle) =>
      new Promise<string>((resolve) => {
        handle.onEvent((event) => {
          if (event.event === "permission-card") resolve(event.request.id);
        });
      });
    const completionFor = (handle: RunHandle) =>
      new Promise<void>((resolve) => {
        handle.onEvent((event) => {
          if (event.event === "completed") resolve();
        });
      });
    const firstPermission = permissionFor(first);
    const secondPermission = permissionFor(second);
    const firstDone = completionFor(first);
    const secondDone = completionFor(second);
    first.submit({
      action: "permission",
      requestId: await firstPermission,
      decision: { decision: "allow", scope: "once" },
    });
    await firstDone;
    await api.updateTask(task.id, { status: "done" });
    second.submit({
      action: "permission",
      requestId: await secondPermission,
      decision: { decision: "allow", scope: "once" },
    });
    await secondDone;
    expect((await api.getTask(task.id)).task.status).toBe("done");

    const third = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "new work after done",
      options: { planMode: false },
    });
    const thirdPermission = permissionFor(third);
    const thirdDone = completionFor(third);
    third.submit({
      action: "permission",
      requestId: await thirdPermission,
      decision: { decision: "allow", scope: "once" },
    });
    await thirdDone;
    expect((await api.getTask(task.id)).task.status).toBe("in-review");
  });

  it("an immediate close settles the turn without leaving a resumable ghost", async () => {
    vi.useFakeTimers();
    try {
      const api = createInMemoryApi(emptySeed());
      const study = await api.createStudy({ title: "Close", key: "CLS" });
      const task = await api.createTask({
        studyId: study.id,
        stage: "methods",
        title: "close before start",
      });
      const handle = await api.startRun({
        studyId: study.id,
        taskId: task.id,
        prompt: "do not start",
        options: { planMode: false },
      });
      const seen: import("./run").RunEvent[] = [];
      handle.onEvent((event) => seen.push(event));

      handle.close();
      await vi.runAllTimersAsync();

      expect(seen).toEqual([
        expect.objectContaining({
          event: "snapshot",
          snapshot: expect.objectContaining({ runId: handle.runId }),
        }),
      ]);
      expect(await api.resumeRuns(task.id)).toEqual([]);
      expect((await api.getTask(task.id)).turns.map((turn) => turn.runId)).toEqual([
        handle.runId,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejecting the plan fails the run before any card", async () => {
    const events = await collect(false, true);
    expect(events.some((e) => e.event === "permission-card")).toBe(false);
    const done = events.at(-1)!;
    expect(done.event === "completed" && done.state.state).toBe("failed");
  });

  it("a soft failure lands a run record alongside the failed state", async () => {
    // Every turn finalizes a record unconditionally — denied and failed
    // turns are part of the study record too. The simulation used to
    // complete a rejected plan with `run: undefined`, so it could not
    // reproduce a failed-but-landed turn at all; that gap is exactly why a
    // presentation bug (prose live, cards after the next send) survived
    // review. Only a hard, unrecoverable error would yield `run: undefined`,
    // which the simulation has no analogue for.
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const task = await api.createTask({
      studyId: study.id,
      stage: "methods",
      title: "run it",
    });
    const session = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "run it",
      options: { planMode: true },
    });
    const done = await new Promise<import("./run").RunEvent>((resolve) => {
      session.onEvent((e) => {
        if (e.event === "plan-proposed")
          session.submit({ action: "reject-plan", reason: "wrong approach" });
        if (e.event === "completed") resolve(e);
      });
    });

    expect(done.event === "completed" && done.state.state).toBe("failed");
    const run = done.event === "completed" ? done.run : undefined;
    expect(run).toBeDefined();
    // `RunStatus` follows the terminal state: not Completed → Failed.
    expect(run!.status).toBe("failed");
    // A failed turn stamps no provenance, so it records no outputs...
    expect(run!.outputs).toEqual([]);
    // ...but everything that had already happened lands with the record: the
    // prose, and the CLI's own ungated plan-file write, which happens BEFORE
    // the plan gate and is therefore part of even a rejected turn.
    expect(run!.stream?.map((item) => item.kind)).toEqual(["text", "step"]);

    // And the persisted turn is that same failed-but-landed turn: same run id,
    // same stream — what the transcript renders from.
    const detail = await api.getTask(task.id);
    const turn = detail.turns[0];
    expect(turn.status).toBe("failed");
    expect(turn.runId).toBe(run!.runId);
    expect(turn.stream).toEqual(run!.stream);
  });

  it("denying the permission resumes execution and completes the run — recorded as a log denial, not a failure", async () => {
    // A denial resumes the prior phase instead of failing the turn. `Cancel`
    // is the hard stop, not `Deny`.
    const events = await collect(true, false);
    const done = events.at(-1)!;
    expect(done.event === "completed" && done.state.state).toBe("completed");

    // The refusal is recorded in the Execution Log...
    const denial = events.find(
      (e) => e.event === "log-entry" && e.entry.decision === "denied",
    );
    expect(denial).toBeDefined();

    // ...execution resumes after the card (still `executing`, plan intact)...
    expect(
      events.some((e) => e.event === "state" && e.state.state === "executing"),
    ).toBe(true);

    // ...and the run finishes ok, without ever producing the denied write's
    // artifact.
    const run = done.event === "completed" ? done.run : undefined;
    expect(run?.status).toBe("ok");
    expect(run?.outputs.some((o) => o.path === "results/out.csv")).toBe(false);
  });

  it("cancelling at a permission card terminates the run", async () => {
    // The counterpart to the test above, and the one the suite was missing:
    // `Deny` resumes, `Cancel` ends. Nothing must execute after the stop, and
    // the run must land `cancelled` rather than quietly completing.
    // (Cancel and Deny are easy to conflate, and a mock can pass while
    // masking that bug — this test pins the exact contract so that can't
    // happen unnoticed.)
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const task = (await api.getStudy(study.id)).tasks[0];
    const session = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "run it",
      options: { planMode: true },
    });

    const events: import("./run").RunEvent[] = [];
    await new Promise<void>((resolve) => {
      session.onEvent((e) => {
        events.push(e);
        if (e.event === "plan-proposed")
          session.submit({ action: "approve-plan" });
        // The researcher hits Stop instead of deciding the card.
        if (e.event === "permission-card") session.submit({ action: "cancel" });
        if (e.event === "completed") resolve();
      });
    });

    const done = events.at(-1)!;
    expect(done.event).toBe("completed");
    expect(done.event === "completed" && done.state.state).toBe("cancelled");
    // A stop is not a decline: it carries no `reason`, and this turn never
    // sat unconfirmed long enough to earn `unacknowledged` either — the
    // landed state is bare `{ state: "cancelled" }`, nothing more.
    expect(done.event === "completed" ? Object.keys(done.state) : []).toEqual([
      "state",
    ]);

    // The turn stopped AT the card, so the write never EXECUTED — but the
    // abandoned call is still on the Execution Log, decision "cancelled" with
    // no result: the stop is on the Execution Log for the record, so the
    // tool the researcher stopped is in the transcript, visibly blocked,
    // instead of vanishing from it.
    const logged = events.filter((e) => e.event === "log-entry");
    // Two: the CLI's ungated plan-file write (which really did happen, before
    // the plan gate) and the Write the researcher stopped at the card.
    expect(logged).toHaveLength(2);
    const last = logged[1];
    const stopped = last.event === "log-entry" ? last.entry : undefined;
    expect(stopped!.decision).toBe("cancelled");
    expect(stopped!.result).toBeUndefined();
    // An abandoned call is not a silent nothing: a live adapter still
    // reports its own follow-up for a call it never got to finish, and that
    // follow-up reads `isError: true` — the researcher stopping the turn is
    // why the call never ran, not evidence nothing went wrong with it.
    expect(stopped!.isError).toBe(true);
    // Nothing ran: no allowed/executed entry exists.
    expect(
      events.some(
        (e) =>
          e.event === "log-entry" && e.entry.decision.startsWith("allowed"),
      ),
    ).toBe(false);
    // It DOES land a run record though — a cancelled turn is part of the
    // study record, stamping no provenance, and its own `status` reads the
    // same `cancelled` the turn's state does rather than misreporting it
    // as `failed`.
    const cancelled = done.event === "completed" ? done.run : undefined;
    expect(cancelled).toBeDefined();
    expect(cancelled!.status).toBe("cancelled");
    expect(cancelled!.outputs).toEqual([]);

    // ...and the turn counts as unfinished, so the Task never advances to
    // review the way a completed run would.
    const after = (await api.getStudy(study.id)).tasks.find(
      (t) => t.id === task.id,
    );
    expect(after?.status).not.toBe("in-review");
  });

  it("cancelling at the plan gate also lands the turn cancelled, not failed", async () => {
    // The same stop, reached one gate earlier: nothing has been proposed to
    // decline yet, so treating this as a decline (`{ state: "failed", reason:
    // "cancelled" }`) would misdescribe it exactly the way it would at the
    // permission card.
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const task = (await api.getStudy(study.id)).tasks[0];
    const session = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "run it",
      options: { planMode: true },
    });

    const done = await new Promise<import("./run").RunEvent>((resolve) => {
      session.onEvent((e) => {
        if (e.event === "plan-proposed") session.submit({ action: "cancel" });
        if (e.event === "completed") resolve(e);
      });
    });

    expect(done.event === "completed" && done.state.state).toBe("cancelled");
    const run = done.event === "completed" ? done.run : undefined;
    expect(run).toBeDefined();
    expect(run!.status).toBe("cancelled");
  });
});

describe("submitRunDecision (in-memory)", () => {
  it("routes a decision addressed by runId alone to the running turn", async () => {
    // The seam a wire transport is built on: nothing here ever touches the
    // `RunHandle` `startRun` returned — only the bare id it carries.
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const task = (await api.getStudy(study.id)).tasks[0];
    const handle = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "run it",
      options: { planMode: true },
    });

    const done = await new Promise<import("./run").RunEvent>((resolve) => {
      handle.onEvent((e) => {
        if (e.event === "plan-proposed")
          void api.submitRunDecision(handle.runId, { action: "approve-plan" });
        if (e.event === "permission-card")
          void api.submitRunDecision(handle.runId, {
            action: "permission",
            requestId: e.request.id,
            decision: { decision: "allow", scope: "once" },
          });
        if (e.event === "completed") resolve(e);
      });
    });

    expect(done.event === "completed" && done.state.state).toBe("completed");
  });

  it("rejects a decision addressed to a run id nobody holds, the same way an unowned one is refused", async () => {
    // Run ids are guessable, so a caller must not be able to tell "no such
    // run" apart from "not yours" by the error it gets back — both answer
    // `forbidden`, the same way the workspace server's own runs do.
    const api = createInMemoryApi();
    await expect(
      api.submitRunDecision("run_nope", { action: "cancel" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a decision from an actor who did not start the run", async () => {
    // The in-memory core has no machine for a run to belong to, but a run
    // still belongs to whoever started it — a lab-mate who merely knows its
    // id is refused the same way a colleague's un-owned machine refuses one.
    const lab = createInMemoryLab();
    const owner = lab.api(lab.ownerId);
    const member = lab.api(lab.memberId);
    const [study] = await owner.listStudies();
    const task = (await owner.getStudy(study.id)).tasks[0];
    const handle = await owner.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "run it",
      options: { planMode: true },
    });

    await expect(
      member.submitRunDecision(handle.runId, { action: "cancel" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a global-scope permission decision by name, rather than narrowing it", async () => {
    // A "global" scope means every Study in the lab, and there is nothing
    // this core could grant that would honestly mean that — refused by
    // name on the way in, the same way the workspace server refuses it.
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const task = (await api.getStudy(study.id)).tasks[0];
    const handle = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "run it",
      options: { planMode: false },
    });
    const requestId = await new Promise<string>((resolve) => {
      handle.onEvent((e) => {
        if (e.event === "permission-card") resolve(e.request.id);
      });
    });

    await expect(
      api.submitRunDecision(handle.runId, {
        action: "permission",
        requestId,
        decision: { decision: "allow", scope: "global" },
      }),
    ).rejects.toThrow(/every Study/);
    handle.close();
  });
});

describe("live streaming (in-memory)", () => {
  it("streams live snapshots and log entries before the run completes", async () => {
    // Drives the run via this contract's actual `RunHandle` idiom:
    // `onEvent`/`submit`, resolved to `completed` via a Promise.
    const api = createInMemoryApi(emptySeed());
    const study = await api.createStudy({ title: "S", key: "S" });
    const task = await api.createTask({
      studyId: study.id,
      stage: "methods",
      title: "do the thing",
    });
    const session = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "do the thing",
      options: { planMode: true },
    });

    const seen: import("./run").RunEvent[] = [];
    await new Promise<void>((resolve) => {
      session.onEvent((e) => {
        seen.push(e);
        if (e.event === "plan-proposed")
          session.submit({ action: "approve-plan" });
        if (e.event === "permission-card")
          session.submit({
            action: "permission",
            requestId: e.request.id,
            decision: { decision: "allow", scope: "once" },
          });
        if (e.event === "completed") resolve();
      });
    });

    const liveIdx = seen.findIndex((e) => e.event === "live");
    const completedIdx = seen.findIndex((e) => e.event === "completed");
    expect(liveIdx).toBeGreaterThanOrEqual(0);
    expect(liveIdx).toBeLessThan(completedIdx);

    // Live snapshots arrive before the run's log entries: the in-flight
    // prose channel opens before any tool call lands.
    const logIdx = seen.findIndex((e) => e.event === "log-entry");
    expect(liveIdx).toBeLessThan(logIdx);

    const live = seen.filter(
      (e): e is Extract<import("./run").RunEvent, { event: "live" }> =>
        e.event === "live",
    );
    // A snapshot REPLACES its predecessor, so the last one must be empty: the
    // turn is over and nothing is in flight. (This is the exact case that
    // tells the UI to stop rendering the in-flight tail — every `LiveTurn`
    // field is skipped when empty, so an idle snapshot really does serialize
    // to `{}`.)
    expect(live.at(-1)?.live).toEqual({});
    // …but the text channel must have been non-empty at some point.
    expect(live.some((e) => (e.live.text ?? "") !== "")).toBe(true);
  });
});

// Drive one turn on a Task to completion — auto-approve the plan, allow the
// one card — so the Task owns a persisted transcript.
async function runTaskTurn(
  api: ReturnType<typeof createInMemoryApi>,
  studyId: string,
  taskId: string,
  prompt: string,
): Promise<void> {
  const handle = await api.startRun({
    studyId,
    taskId,
    prompt,
    options: { planMode: true },
  });
  await new Promise<void>((resolve) => {
    handle.onEvent((e) => {
      if (e.event === "plan-proposed") handle.submit({ action: "approve-plan" });
      if (e.event === "permission-card")
        handle.submit({
          action: "permission",
          requestId: e.request.id,
          decision: { decision: "allow", scope: "once" },
        });
      if (e.event === "completed") resolve();
    });
  });
}

/** A Task in `studyId` with a transcript of its own, for a test that needs
 *  a chat nobody else has spoken in. */
async function chatTask(
  api: ReturnType<typeof createInMemoryApi>,
  studyId: string,
  title: string,
) {
  return api.createTask({ studyId, stage: "methods", title });
}

describe("tasks: delete and rename (in-memory)", () => {
  it("deleting a Task takes its transcript with it", async () => {
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const task = await chatTask(api, study.id, "look into this");
    await runTaskTurn(api, study.id, task.id, "look into this");

    // Listed and reopenable before deletion.
    expect((await api.getStudy(study.id)).tasks.map((t) => t.id)).toContain(
      task.id,
    );
    expect((await api.getTask(task.id)).turns.length).toBeGreaterThan(0);

    // Delete: gone from the Study, no longer reopenable.
    await api.deleteTask(task.id);
    expect((await api.getStudy(study.id)).tasks.map((t) => t.id)).not.toContain(
      task.id,
    );
    await expect(api.getTask(task.id)).rejects.toThrow(
      `no such task: ${task.id}`,
    );
  });

  it("updateTask renames and pins without touching the transcript", async () => {
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const a = await chatTask(api, study.id, "first chat");
    await runTaskTurn(api, study.id, a.id, "first chat");

    // A rename replaces the title, trimmed, and leaves the turns alone.
    const renamed = await api.updateTask(a.id, {
      title: "  Auth refactor notes  ",
    });
    expect(renamed.title).toBe("Auth refactor notes");
    const detail = await api.getTask(a.id);
    expect(detail.task.title).toBe("Auth refactor notes");
    expect(detail.turns[0].prompt).toBe("first chat");

    // Pin is presentation only, and survives a later title-only patch
    // (patches are sparse, not snapshots).
    expect((await api.updateTask(a.id, { pinned: true })).pinned).toBe(true);
    expect((await api.updateTask(a.id, { title: "Still pinned" })).pinned).toBe(
      true,
    );
    expect("pinned" in (await api.updateTask(a.id, { pinned: false }))).toBe(false);

    // A blank rename and an unknown id are both clean errors.
    await expect(api.updateTask(a.id, { title: "   " })).rejects.toThrow(
      "task title must not be empty",
    );
    await expect(
      api.updateTask("t_nope", { pinned: true }),
    ).rejects.toThrow("no such task: t_nope");
  });

  it("deleteStudy drops the Study with its tasks and their transcripts", async () => {
    const api = createInMemoryApi();
    const [study, other] = await api.listStudies();
    const task = await chatTask(api, study.id, "look into this");
    await runTaskTurn(api, study.id, task.id, "look into this");
    expect((await api.getStudy(study.id)).tasks.length).toBeGreaterThan(0);

    await api.deleteStudy(study.id);

    // Gone from the list, unopenable, and its Tasks' chats went with it.
    expect((await api.listStudies()).map((s) => s.id)).not.toContain(study.id);
    await expect(api.getStudy(study.id)).rejects.toThrow();
    await expect(api.getTask(task.id)).rejects.toThrow();
    expect((await api.myWork()).every((t) => t.studyId !== study.id)).toBe(
      true,
    );
    expect(
      (await api.listConversations()).every(
        (c) => c.conversation.studyId !== study.id,
      ),
    ).toBe(true);

    // The other Study is untouched; a second delete is a clean error.
    expect((await api.getStudy(other.id)).study?.id).toBe(other.id);
    await expect(api.deleteStudy(study.id)).rejects.toThrow();
  });
});

describe("study lifecycle (in-memory)", () => {
  it("every chat names its author", async () => {
    const api = createInMemoryApi();
    const me = await api.currentUser();
    const [seeded] = await api.listStudies();
    const task = await chatTask(api, seeded.id, "who ran this");
    await runTaskTurn(api, seeded.id, task.id, "who ran this");
    expect((await api.getTask(task.id)).task.createdBy).toBe(me.id);
  });
});

describe("task transcripts: stream (in-memory)", () => {
  it("getTask returns a turn whose stream interleaves text and step items in arrival order", async () => {
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const task = await chatTask(api, study.id, "profile the dataset");

    const session = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "profile the dataset",
      options: { planMode: true },
    });
    await new Promise<void>((resolve) => {
      session.onEvent((e) => {
        if (e.event === "plan-proposed")
          session.submit({ action: "approve-plan" });
        if (e.event === "permission-card")
          session.submit({
            action: "permission",
            requestId: e.request.id,
            decision: { decision: "allow", scope: "once" },
          });
        if (e.event === "completed") resolve();
      });
    });

    const detail = await api.getTask(task.id);
    const turn = detail.turns[0];
    expect(turn.stream).toBeDefined();
    const kinds = turn.stream!.map((item) => item.kind);
    // Genuinely interleaved: not all text followed by all steps.
    expect(kinds).toContain("text");
    expect(kinds).toContain("step");
    expect(kinds.indexOf("step")).toBeGreaterThan(0);
    expect(kinds.indexOf("step")).toBeLessThan(kinds.length - 1);

    // The step item carries the same Execution Log entry shape. The GATED
    // write is the one under test here (the turn also carries the CLI's
    // ungated plan-file write, covered by its own test below).
    const step = turn.stream!.find(
      (item) => item.kind === "step" && item.entry.decision === "allowed-once",
    );
    expect(step && step.kind === "step" && step.entry.tool).toBe("Write");

    // …with the REAL `claude` Write key. An Execution Log entry carries the
    // tool input verbatim, and the transcript's deterministic label reads
    // `file_path` — swap in a made-up key and the demo card silently
    // degrades from "Wrote results/out.csv" to a bare "Write", with nothing
    // else failing.
    expect(step && step.kind === "step" && step.entry.input).toEqual({
      file_path: "results/out.csv",
    });

    // The text items match `messages` in order.
    const textItems = turn
      .stream!.filter((item) => item.kind === "text")
      .map((item) => (item.kind === "text" ? item.text : ""));
    expect(textItems).toEqual(turn.messages);
  });

  it("records an ungated write that left the workspace, and flags only that one", async () => {
    // Evidence against the real `claude` CLI: in plan mode the CLI
    // auto-allows its own plan-file write to ~/.claude/plans/… — no
    // `can_use_tool` request is ever raised, so the seam cannot block it and
    // only learns of it from the announcement. That access left the
    // workspace (`outsideWorkspace`); the simulation must be able to produce
    // exactly that entry, or no UI test could reproduce the card that says
    // so. The gated write INSIDE the workspace must NOT carry the flag.
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const task = await chatTask(api, study.id, "count the responders");
    const session = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "count the responders",
      options: { planMode: true },
    });
    const done = await new Promise<import("./run").RunEvent>((resolve) => {
      session.onEvent((e) => {
        if (e.event === "plan-proposed")
          session.submit({ action: "approve-plan" });
        if (e.event === "permission-card")
          session.submit({
            action: "permission",
            requestId: e.request.id,
            decision: { decision: "allow", scope: "once" },
          });
        if (e.event === "completed") resolve(e);
      });
    });

    const run = done.event === "completed" ? done.run : undefined;
    const steps = (run!.stream ?? []).flatMap((item) =>
      item.kind === "step" ? [item.entry] : [],
    );
    const escaped = steps.filter((e) => e.outsideWorkspace);
    expect(escaped).toHaveLength(1);
    // Ungated: announced and executed, never gated — decision "ran".
    expect(escaped[0].decision).toBe("ran");
    expect(escaped[0].tool).toBe("Write");

    // The gated write inside the workspace is not flagged — the flag is a
    // property of the path, not of "a write happened".
    const inside = steps.find((e) => e.decision === "allowed-once");
    expect(inside).toBeDefined();
    expect(inside!.outsideWorkspace).toBeFalsy();
  });

  it("stopping the turn at the permission card records the abandoned step as `cancelled`", async () => {
    // A cancelled call at the gate still pushes an Execution Log entry —
    // decision "cancelled", `isError: true`, NO result — plus its order slot:
    // the stop is on the Execution Log for the record, so the tool the
    // researcher stopped is visibly blocked in the transcript rather than
    // vanishing from it. The simulation tracks that exact contract; that is
    // the only reason UI tests may run against it.
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const task = await chatTask(api, study.id, "write the results");
    const session = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "write the results",
      options: { planMode: true },
    });
    const done = await new Promise<import("./run").RunEvent>((resolve) => {
      session.onEvent((e) => {
        if (e.event === "plan-proposed")
          session.submit({ action: "approve-plan" });
        if (e.event === "permission-card") session.submit({ action: "cancel" });
        if (e.event === "completed") resolve(e);
      });
    });

    expect(done.event === "completed" && done.state.state).toBe("cancelled");
    const run = done.event === "completed" ? done.run : undefined;
    expect(run).toBeDefined();
    expect(run!.status).toBe("cancelled");

    // The abandoned step is present in the landed stream, in arrival order —
    // after the ungated plan-file write, which happened before the plan gate.
    const steps = (run!.stream ?? []).filter((item) => item.kind === "step");
    expect(steps).toHaveLength(2);
    const entry = steps[1].kind === "step" ? steps[1].entry : undefined;
    expect(entry!.decision).toBe("cancelled");
    expect(entry!.tool).toBe("Write");
    expect(entry!.input).toEqual({ file_path: "results/out.csv" });
    // An abandoned call still reads `isError: true` — the adapter's own
    // follow-up for a call it never got to finish reports it failed, even
    // though a researcher stopping the turn, not the tool itself, is why.
    expect(entry!.isError).toBe(true);
    // ...and it never ran, so there is no result to attach.
    expect(entry!.result).toBeUndefined();

    // And it is what a reopened chat reads from.
    const detail = await api.getTask(task.id);
    expect(detail.turns[0].stream).toEqual(run!.stream);
  });
});

describe("subagent delegation (in-memory)", () => {
  it("runs an isolated child into the parent's transcript, and creates no Task of its own", async () => {
    const api = createInMemoryApi();
    const [study] = await api.listStudies();
    const parent = await chatTask(api, study.id, "the parent chat");
    const before = (await api.getStudy(study.id)).tasks.length;

    const persona = {
      name: "Data Scientist",
      description: "Profiles datasets",
      systemPrompt: "You are the Data Scientist.",
      tools: ["Read", "Write"],
    };
    const session = await api.delegateSubagent({
      studyId: study.id,
      taskId: parent.id,
      parentRunId: "run_parent",
      persona,
      task: "profile the dataset",
      options: { planMode: true },
    });

    const done = await new Promise<import("./run").RunEvent>((resolve) => {
      session.onEvent((e) => {
        if (e.event === "plan-proposed")
          session.submit({ action: "approve-plan" });
        if (e.event === "permission-card")
          session.submit({
            action: "permission",
            requestId: e.request.id,
            decision: { decision: "allow", scope: "once" },
          });
        if (e.event === "completed") resolve(e);
      });
    });
    expect(done.event === "completed" && done.state.state).toBe("completed");

    // The child rolled into the parent Task's transcript, tagged as a
    // subagent turn.
    const detail = await api.getTask(parent.id);
    const child = detail.turns.find((t) => t.subagent === "Data Scientist");
    expect(child).toBeDefined();
    expect(child!.parentRunId).toBe("run_parent");
    expect(child!.prompt).toBe("profile the dataset"); // isolation: task only

    // No second Task was created — a subagent turn is a step inside a chat,
    // not a chat of its own.
    expect((await api.getStudy(study.id)).tasks.length).toBe(before);
  });

  it("reserves a delegated child's sequence before it can finish ahead of its live parent", async () => {
    const api = createInMemoryApi(emptySeed());
    const study = await api.createStudy({ title: "Chronology", key: "CHR" });
    const task = await api.createTask({
      studyId: study.id,
      stage: "methods",
      title: "interleave parent and child",
    });
    const finish = async (handle: RunHandle) => {
      let requestId = "";
      await new Promise<void>((resolve) => {
        handle.onEvent((event) => {
          if (event.event === "permission-card") {
            requestId = event.request.id;
            handle.submit({
              action: "permission",
              requestId,
              decision: { decision: "allow", scope: "once" },
            });
          }
          if (event.event === "completed") resolve();
        });
      });
    };

    const baseline = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "baseline turn",
      options: { planMode: false },
    });
    await finish(baseline);

    const parent = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "live parent",
      options: { planMode: false },
    });
    let parentPermission = "";
    let parentFinished!: () => void;
    const parentDone = new Promise<void>((resolve) => (parentFinished = resolve));
    await new Promise<void>((resolve) => {
      parent.onEvent((event) => {
        if (event.event === "permission-card") {
          parentPermission = event.request.id;
          resolve();
        }
        if (event.event === "completed") parentFinished();
      });
    });
    const [liveParent] = await api.resumeRuns(task.id);
    expect(liveParent.snapshot.sequence).toBe(2);

    const child = await api.delegateSubagent({
      studyId: study.id,
      taskId: task.id,
      parentRunId: parent.runId,
      persona: {
        name: "Statistician",
        description: "Checks the analysis",
        systemPrompt: "Check the analysis.",
        tools: ["Read"],
      },
      task: "finish before the parent",
      options: { planMode: false },
    });
    await finish(child);

    const childTurn = (await api.getTask(task.id)).turns.find(
      (turn) => turn.runId === child.runId,
    );
    expect(childTurn?.sequence).toBe(3);
    expect(childTurn!.sequence).toBeGreaterThan(liveParent.snapshot.sequence);

    parent.submit({ action: "cancel" });
    await parentDone;
    expect(parentPermission).not.toBe("");
  });
});

describe("assignees", () => {
  it("a Task is on people, agents, or both", () => {
    const mixed: Assignee[] = [
      { kind: "user", userId: "u_amara" },
      { kind: "agent", name: "statistician" },
    ];
    expect(mixed.map((a) => a.kind)).toEqual(["user", "agent"]);
  });
});

describe("language axis (in-memory)", () => {
  it("kernelExecute for Python (default) rejects with a browser-only error", async () => {
    // The exact wording — "isn't available in the browser" — is this
    // implementation's own reason for refusing; the conformance suite only
    // holds every implementation to rejecting, not to this message.
    const api = createInMemoryApi();
    const study = await api.createStudy({ title: "Kernel", key: "KRN" });
    await expect(api.kernelExecute(study.id, "1 + 1")).rejects.toThrow(
      /managed Python kernel isn't available in the browser/i,
    );
  });
});

describe("workspace settings (in-memory)", () => {
  it("defaults the data location to ~/lykeion", async () => {
    // `~/lykeion` is this implementation's own default; the conformance
    // suite doesn't assert it because a real workspace server would
    // legitimately choose its own location.
    const api = createInMemoryApi(emptySeed());
    const s = await api.getSettings();
    expect(s.dataLocation).toBe("~/lykeion");
  });
});

describe("current user (in-memory)", () => {
  it("returns the seeded owner identity", async () => {
    const api = createInMemoryApi(emptySeed());
    const user = await api.currentUser();
    expect(user).toEqual({
      id: "u_you",
      email: "you@lab.example",
      displayName: "You",
      createdTs: 0,
    });
  });
});

describe("identity", () => {
  it("User carries an id and a creation time", () => {
    const sample: User = {
      id: "u_1",
      email: "amara@lab.example",
      displayName: "Amara",
      createdTs: 1,
    };
    expect(Object.keys(sample).sort()).toEqual([
      "createdTs",
      "displayName",
      "email",
      "id",
    ]);
  });

  it("a Member embeds its user, so one call renders a row", () => {
    const sample: Member = {
      user: {
        id: "u_1",
        email: "amara@lab.example",
        displayName: "Amara",
        createdTs: 1,
      },
      role: "owner",
      joinedTs: 1,
    };
    expect(sample.user.displayName).toBe("Amara");
    expect(sample.removedTs).toBeUndefined();
  });

  it("an Invite states who minted it and when it lapses", () => {
    const sample: Invite = {
      code: "abc",
      role: "member",
      createdBy: "u_1",
      createdTs: 1,
      expiresTs: 2,
    };
    expect(sample.expiresTs).toBeGreaterThan(sample.createdTs);
  });
});

describe("in-memory identity", () => {
  it("seeds an owner and a second member", async () => {
    const api = createInMemoryApi();
    const members = await api.listMembers();
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.role)).toContain("owner");
    expect(members.map((m) => m.role)).toContain("member");
  });

  it("offboarding is soft — the member stays listed with a removal time", async () => {
    const api = createInMemoryApi();
    const before = await api.listMembers();
    const other = before.find((m) => m.role === "member")!;
    await api.removeMember(other.user.id);
    const after = await api.listMembers();
    expect(after).toHaveLength(2);
    expect(after.find((m) => m.user.id === other.user.id)!.removedTs).toBeTypeOf(
      "number",
    );
  });

  it("an empty seed still has an owner — a lab with no one cannot be used", async () => {
    const api = createInMemoryApi(emptySeed());
    expect(await api.listMembers()).toHaveLength(1);
  });
});

describe("a Task's transcript (in-memory)", () => {
  async function fixture() {
    const api = createInMemoryApi();
    // CMP specifically: the fixture needs a Study with several tasks, which
    // is a property of CMP, not of whichever Study lists first.
    const study = (await api.listStudies()).find((s) => s.key === "CMP")!;
    const detail = await api.getStudy(study.id);
    return { api, study, tasks: detail.tasks };
  }

  it("a Task accumulates the turns run against it, oldest first", async () => {
    const { api, study, tasks } = await fixture();
    const task = tasks[0];
    await runTaskTurn(api, study.id, task.id, "look into this");
    await runTaskTurn(api, study.id, task.id, "and then this");

    const turns = (await api.getTask(task.id)).turns;
    expect(turns.map((t) => t.prompt)).toEqual([
      "look into this",
      "and then this",
    ]);
    // Turn order is the clock's, not the array's: each turn is stamped after
    // the one before it.
    expect(turns[0].ts).toBeLessThan(turns[1].ts);
  });

  it("rolls the turns up onto the Task rather than storing a second copy", async () => {
    const { api, study, tasks } = await fixture();
    const task = tasks[0];
    await runTaskTurn(api, study.id, task.id, "look into this");
    await runTaskTurn(api, study.id, task.id, "and then this");

    const detail = await api.getTask(task.id);
    // Count, outcome and the activity stamp are all derived from the turns.
    expect(detail.task.runCount).toBe(detail.turns.length);
    expect(detail.task.lastRunStatus).toBe(detail.turns.at(-1)!.status);
    expect(detail.task.updatedTs).toBeGreaterThanOrEqual(
      detail.turns.at(-1)!.ts,
    );
  });

  it("a completed turn moves the Task on to In Review", async () => {
    const { api, study } = await fixture();
    const task = await chatTask(api, study.id, "do the work");
    expect(task.status).toBe("todo");

    await runTaskTurn(api, study.id, task.id, "do the work");

    const after = (await api.getTask(task.id)).task;
    expect(after.status).toBe("in-review");
    expect(after.lastRunStatus).toBe("ok");
  });

  it("a failed turn still lands on the Task, and leaves its status where it was", async () => {
    const { api, study } = await fixture();
    const task = await chatTask(api, study.id, "try it");
    const handle = await api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "try it",
      options: { planMode: true },
    });
    await new Promise<void>((resolve) => {
      handle.onEvent((e) => {
        if (e.event === "plan-proposed")
          handle.submit({ action: "reject-plan", reason: "wrong approach" });
        if (e.event === "completed") resolve();
      });
    });

    const after = await api.getTask(task.id);
    // The turn is part of the record whatever its outcome...
    expect(after.turns).toHaveLength(1);
    expect(after.task.runCount).toBe(1);
    expect(after.task.lastRunStatus).toBe("failed");
    // ...but only work that actually landed moves the Task on.
    expect(after.task.status).toBe("todo");
  });

  it("deleting one Task leaves the Study's other Tasks and their chats alone", async () => {
    const { api, study, tasks } = await fixture();
    await runTaskTurn(api, study.id, tasks[1].id, "the survivor's turn");

    await api.deleteTask(tasks[0].id);

    await expect(api.getTask(tasks[0].id)).rejects.toThrow();
    expect((await api.getTask(tasks[1].id)).turns).toHaveLength(1);
    expect((await api.getStudy(study.id)).tasks.map((t) => t.id)).toContain(
      tasks[1].id,
    );
  });

  it("lists a Study's tasks by number, whatever order the store holds them in", async () => {
    // A number is handed out at creation, so tasks made through the contract
    // are stored in number order and any answer at all looks sorted. This
    // seed holds one Study's tasks out of number order, which is the only
    // arrangement that separates a real ordering from the store's own.
    const seed = emptySeed();
    seed.studies.push({
      id: "s_ord",
      key: "ORD",
      title: "Out-of-order store",
      createdBy: "u_you",
      createdTs: 10,
      updatedTs: 10,
    });
    const task = (id: string, number: number) => ({
      id,
      number,
      studyId: "s_ord",
      stage: "methods" as const,
      title: `Task ${number}`,
      status: "todo" as const,
      priority: "none" as const,
      createdBy: "u_you",
      runCount: 0,
      createdTs: 10,
      updatedTs: 10,
    });
    seed.tasks.push(task("t_third", 3), task("t_first", 1), task("t_second", 2));

    const api = createInMemoryApi(seed);

    expect((await api.getStudy("s_ord")).tasks.map((t) => t.number)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("the chat the store ships", () => {
  it("gives CMP-3 a transcript whose turns are in the order they were sent", async () => {
    const api = createInMemoryApi();
    const detail = await api.getTask("t_3");
    expect(detail.task.runCount).toBe(2);

    expect(detail.turns.map((t) => t.prompt)).toEqual([
      "Motion-correct the deprivation cohort and segment ROIs from the two-photon stacks.",
      "Summarize what landed, and flag anything a reviewer should check before this moves on.",
    ]);
    // Turn order is the clock's, not the array's: each turn is stamped after
    // the one before it.
    expect(detail.turns[0].ts).toBeLessThan(detail.turns[1].ts);
  });

  it("derives the Task's roll-up rather than carrying a written one", async () => {
    const api = createInMemoryApi();
    const detail = await api.getTask("t_3");

    // Count, outcome and the activity stamp all come from replaying the
    // turns — the seed writes none of them.
    expect(detail.task.runCount).toBe(detail.turns.length);
    expect(detail.task.lastRunStatus).toBe("ok");
    expect(detail.task.updatedTs).toBe(detail.turns[1].ts);
    expect(detail.turns[0].ts).toBeLessThan(detail.task.updatedTs);
    // And the Task is the store's own, authored by the store's identity.
    expect(detail.task.createdBy).toBe((await api.currentUser()).id);
  });

  it("stamps its turns with run ids from the same sequence a live run draws on", async () => {
    const api = createInMemoryApi();
    const before = await api.getTask("t_3");
    const seededIds = before.turns.map((t) => t.runId);
    expect(new Set(seededIds).size).toBe(seededIds.length);

    // A live turn appended to the very same Task cannot collide with the
    // seeded ones, and lands after them.
    const live = await api.startRun({
      studyId: "s_cmp",
      taskId: "t_3",
      prompt: "Re-run the SNR filter.",
      options: { planMode: false },
    });
    await new Promise<void>((resolve) => {
      live.onEvent((e) => {
        if (e.event === "permission-card")
          live.submit({
            action: "permission",
            requestId: e.request.id,
            decision: { decision: "allow", scope: "once" },
          });
        if (e.event === "completed") resolve();
      });
    });

    const after = await api.getTask("t_3");
    const allIds = after.turns.map((t) => t.runId);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.slice(0, 2)).toEqual(seededIds);
  });

  it("gives a seeded turn the same shape a live run's turn has", async () => {
    const api = createInMemoryApi();
    const seeded = (await api.getTask("t_3")).turns[0];

    // A real turn, appended to the same Task.
    await runTaskTurn(api, "s_cmp", "t_3", "Re-run the SNR filter.");
    const turns = (await api.getTask("t_3")).turns;
    const live = turns.at(-1)!;
    // The two really are different turns, so the comparison below is between
    // the seeding path and the run path rather than one turn read twice.
    expect(turns.length).toBe(3);
    expect(live.runId).not.toBe(seeded.runId);

    // Same fields, one for one. `stream` is the single legitimate difference:
    // it holds the prose and tool steps a run emitted, and a replay has none
    // to hold. Every other field a turn carries — runId, ts, prompt, messages,
    // status, code, outputs — is written by the same code for both, and a
    // seeding path that stopped writing them would show up here as a shorter
    // key set.
    expect(Object.keys(seeded).sort()).toEqual(
      Object.keys(live)
        .filter((k) => k !== "stream")
        .sort(),
    );
    expect(Object.keys(live)).toContain("stream");
  });

  it("ships the transcript on the Task it belongs to, and no other", async () => {
    const api = createInMemoryApi();
    // The seeded chat IS CMP-3 — there is no separate record to join.
    expect((await api.getTask("t_3")).turns).toHaveLength(2);
    const others = (await api.getStudy("s_cmp")).tasks.filter(
      (t) => t.id !== "t_3",
    );
    expect(others.length).toBeGreaterThan(0);
    for (const t of others) {
      expect(t.runCount).toBe(0);
      expect((await api.getTask(t.id)).turns).toEqual([]);
    }
  });

  it("ships no chat on an empty seed", async () => {
    const api = createInMemoryApi(emptySeed());
    const task = await api.createTask({ stage: "background", title: "Fresh" });
    expect((await api.getTask(task.id)).turns).toEqual([]);
    expect(task.runCount).toBe(0);
  });
});

it("runs every area the suite defines against somebody", () => {
  // An area written and left off both lists runs nowhere and fails nothing,
  // which is the one way this file can be incomplete without saying so.
  // Counted by export rather than by name, so adding an area to the module
  // and forgetting the list is what trips it. `rolesConformance`,
  // `unknownRunConformance` and `runDecisionConformance` are excluded: all
  // three take a lab rather than an api and `runContractConformance` always
  // runs them itself, so none belongs to `ALL_AREAS` or its skip mechanism.
  const exported = Object.entries(areaExports)
    .filter(
      ([name]) =>
        name.endsWith("Conformance") &&
        name !== "runContractConformance" &&
        name !== "rolesConformance" &&
        name !== "unknownRunConformance" &&
        name !== "runDecisionConformance" &&
        name !== "runResumeConformance",
    )
    .map(([, fn]) => fn);
  expect(exported).toHaveLength(ALL_AREAS.length);
  for (const area of exported) expect(ALL_AREAS).toContain(area);
});

/** Two identities on the default seed's lab, for the role rules every
 *  `runContractConformance` call below is held to regardless of which seed
 *  its own `makeApi` starts from. */
async function makeDefaultLab() {
  const lab = createInMemoryLab();
  return { owner: lab.api(lab.ownerId), member: lab.api(lab.memberId) };
}

runContractConformance("in-memory core", async () => createInMemoryApi(), {
  makeLab: makeDefaultLab,
});
runContractConformance(
  "in-memory, empty seed",
  async () => createInMemoryApi(emptySeed()),
  { makeLab: makeDefaultLab },
);
