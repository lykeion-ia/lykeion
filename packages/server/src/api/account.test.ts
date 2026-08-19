import { afterEach, afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLykeionError } from "@lykeion/api";
import { openStore } from "../store/sqlite";
import { migrate, nextSeq } from "../store/migrations";
import { readConfig } from "../config";
import { createChannel } from "../channel";
import { createRunRelay } from "../run-relay";
import { createRevertRegistry } from "../run-revert";
import { createKernelListRegistry } from "../kernel-list-registry";
import { createTitleRegistry } from "../title-registry";
import { createPendingCells } from "../kernel-cells";
import { createEnvSetupRegistry } from "../env-setup-registry";
import { changeRecorder } from "./changes";
import { accountApi } from "./account";
import { createWorkspaceApi, type Deps } from "./index";
import type { Store } from "../store/store";
import { makeServerLab } from "../test-support/test-lab";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-account-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  return store;
}

afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      // One store failing to close must not strand the rest.
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Nothing here is worth failing a test that already passed.
    }
  }
});

const NOW = 1_800_000_000;

/** A member of the lab, written straight to the store — these tests are
 *  about what `accountApi` reads back, not about how people are admitted. */
function addMember(
  store: Store,
  id: string,
  displayName: string,
  role: "owner" | "member",
  joinedTs: number,
  removedTs?: number,
): void {
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `${id}@lab.example`, displayName, "x", joinedTs, nextSeq(store)],
  );
  store.run(
    `INSERT INTO members (user_id, role, joined_ts, removed_ts, seq)
     VALUES (?, ?, ?, ?, ?)`,
    [id, role, joinedTs, removedTs ?? null, nextSeq(store)],
  );
}

function depsFor(store: Store, userId: string, role: "owner" | "member"): Deps {
  const actor = { userId, role };
  const channel = createChannel(store, 1000);
  return {
    store,
    actor,
    now: () => NOW,
    config: readConfig({}),
    // A real channel rather than a stub: it is the cheapest place to leave
    // the recorder's publish path actually exercised.
    channel,
    runs: createRunRelay(),
    reverts: createRevertRegistry(),
    kernelLists: createKernelListRegistry(), titles: createTitleRegistry(), pendingCells: createPendingCells(), envSetups: createEnvSetupRegistry(),
    changes: changeRecorder({ store, actorId: actor.userId, now: () => NOW, channel }),
  };
}

it("resolves the signed-in member from the actor, never from an argument", async () => {
  const store = freshStore();
  addMember(store, "u_ana", "Ana", "owner", NOW);
  addMember(store, "u_bo", "Bo", "member", NOW);

  const asAna = await accountApi(depsFor(store, "u_ana", "owner")).currentUser();
  const asBo = await accountApi(depsFor(store, "u_bo", "member")).currentUser();

  expect(asAna.displayName).toBe("Ana");
  expect(asAna.email).toBe("u_ana@lab.example");
  expect(asBo.displayName).toBe("Bo");
});

it("refuses to name a caller the lab has no user row for", async () => {
  const store = freshStore();
  const err = await accountApi(depsFor(store, "u_ghost", "member"))
    .currentUser()
    .then(() => undefined, (e: unknown) => e);
  expect(isLykeionError(err) && err.code).toBe("not-found");
});

it("lists members joined-date ascending, insertion order breaking the tie", async () => {
  // Every member here joined in the same second, which is what a seeded lab
  // or a scripted import looks like. Timestamp alone cannot order them, so
  // the answer has to come from the sequence they were written in.
  const store = freshStore();
  addMember(store, "u_1", "First", "owner", NOW);
  addMember(store, "u_2", "Second", "member", NOW);
  addMember(store, "u_3", "Third", "member", NOW);

  const members = await accountApi(depsFor(store, "u_1", "owner")).listMembers();

  expect(members.map((m) => m.user.id)).toEqual(["u_1", "u_2", "u_3"]);
});

it("sorts an earlier joiner first even when it was written last", async () => {
  // The tiebreak must not become the whole sort: a member admitted a week
  // ago belongs above one admitted today, whatever order the rows landed in.
  const store = freshStore();
  addMember(store, "u_recent", "Recent", "owner", NOW);
  addMember(store, "u_old", "Old", "member", NOW - 604_800);

  const members = await accountApi(depsFor(store, "u_recent", "owner")).listMembers();

  expect(members.map((m) => m.user.id)).toEqual(["u_old", "u_recent"]);
});

it("keeps offboarded members listed, and says which they are", async () => {
  // Removal is soft so authorship stays attributable. A row that comes back
  // without `removedTs` renders as a current member, which is the opposite
  // of what happened.
  const store = freshStore();
  addMember(store, "u_here", "Here", "owner", NOW);
  addMember(store, "u_gone", "Gone", "member", NOW, NOW + 500);

  const members = await accountApi(depsFor(store, "u_here", "owner")).listMembers();
  const gone = members.find((m) => m.user.id === "u_gone")!;
  const here = members.find((m) => m.user.id === "u_here")!;

  expect(gone.removedTs).toBe(NOW + 500);
  // Absent rather than null or undefined-valued: the field is optional on
  // the contract, and a present key with no value reads as "removed" to
  // anything checking for the property.
  expect("removedTs" in here).toBe(false);
});

it("reports each member's role as the lab recorded it", async () => {
  const store = freshStore();
  addMember(store, "u_owner", "Owner", "owner", NOW);
  addMember(store, "u_member", "Member", "member", NOW);

  const members = await accountApi(depsFor(store, "u_owner", "owner")).listMembers();

  expect(members.find((m) => m.user.id === "u_owner")!.role).toBe("owner");
  expect(members.find((m) => m.user.id === "u_member")!.role).toBe("member");
});

it("answers from the real family, not from the absent one it is spread over", async () => {
  // The composition root layers real implementations on top of honest
  // placeholders. If that order ever inverts, the placeholder wins and the
  // method starts answering empty — with the compiler satisfied either way,
  // because it sees the union of the keys and never their order.
  const store = freshStore();
  addMember(store, "u_ana", "Ana", "owner", NOW);
  const api = createWorkspaceApi(depsFor(store, "u_ana", "owner"));

  expect((await api.currentUser()).displayName).toBe("Ana");
  expect((await api.listMembers()).map((m) => m.user.id)).toEqual(["u_ana"]);
});

it("still answers honestly for everything nothing writes to yet", async () => {
  // The other half of the same guarantee: a method with no implementation
  // behind it must report emptiness rather than be missing from the object.
  const store = freshStore();
  addMember(store, "u_ana", "Ana", "owner", NOW);
  const api = createWorkspaceApi(depsFor(store, "u_ana", "owner"));

  expect(await api.listResearches()).toEqual([]);
  expect(await api.listMachines()).toEqual([]);
  expect(await api.usage()).toEqual({ series: [], agents: [], users: [] });

  const err = await api
    .startRun({ researchId: "s_1", taskId: "t_1", prompt: "go", options: { planMode: false } })
    .then(() => undefined, (e: unknown) => e);
  expect(isLykeionError(err) && err.code).toBe("unsupported");
});

const labCleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const done of labCleanups.splice(0)) await done();
});

async function lab(overrides?: Parameters<typeof makeServerLab>[0]) {
  const built = await makeServerLab(overrides);
  labCleanups.push(built.close);
  return built;
}

it("refuses a member the methods only an owner may call", async () => {
  const { memberApi } = await lab();
  for (const call of [
    () => memberApi.createInvite("member"),
    () => memberApi.listInvites(),
    () => memberApi.revokeInvite("anything"),
    () => memberApi.removeMember("u_someone"),
  ]) {
    const err = await call().then(() => undefined, (e: unknown) => e);
    expect(isLykeionError(err) && err.code).toBe("forbidden");
  }
});

it("stops an offboarded member on their very next call", async () => {
  const { ownerApi, memberApi, memberId } = await lab();
  expect(await memberApi.currentUser()).toBeDefined();
  await ownerApi.removeMember(memberId);
  const err = await memberApi.currentUser().then(() => undefined, (e: unknown) => e);
  expect(isLykeionError(err) && err.code).toBe("unauthenticated");
});

it("keeps an offboarded member's authorship readable", async () => {
  // The reason removal is soft. A Task they wrote must still resolve their
  // name, or the record is corrupted to reclaim a row.
  const { ownerApi, memberApi, memberId } = await lab();
  const research = await ownerApi.createResearch({ title: "Attribution", key: "ATT" });
  const task = await memberApi.createTask({ researchId: research.id, stage: "methods", title: "Theirs" });
  await ownerApi.removeMember(memberId);
  expect((await ownerApi.getTask(task.id)).task.createdBy).toBe(memberId);
  const still = (await ownerApi.listMembers()).find((m) => m.user.id === memberId);
  expect(still?.user.displayName).not.toBe("");
  expect(still?.removedTs).toBeGreaterThan(0);
});

it("does not call an owner who has already gone the last one standing", async () => {
  // Two owners, one offboarded. Asking again for what has already happened
  // must answer the same way asking twice for anything else does — and must
  // not refuse on the grounds of a rule about the last owner, which the
  // person being named has not been since the first call.
  const { ownerApi, base } = await lab();
  const second = await ownerApi.createInvite("owner");
  const redeemed = await fetch(`${base}/auth/redeem-invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: second.code,
      email: "second-owner@lab.example",
      displayName: "Second Owner",
      password: "a good long password",
    }),
  });
  expect(redeemed.status).toBe(200);
  const secondId = (await ownerApi.listMembers()).find(
    (m) => m.user.email === "second-owner@lab.example",
  )!.user.id;

  await ownerApi.removeMember(secondId);
  await expect(ownerApi.removeMember(secondId)).resolves.toBeUndefined();

  const roster = await ownerApi.listMembers();
  expect(roster.find((m) => m.user.id === secondId)!.removedTs).toBeGreaterThan(0);
});

it("keeps two members' themes apart on one server", async () => {
  // The shared suite says outright it cannot show this: it compares two
  // instances, and a single-value store would pass that identically.
  const { ownerApi, memberApi } = await lab();
  await ownerApi.setTheme("aurora");
  await memberApi.setTheme("dawn");
  expect((await ownerApi.getSettings()).theme).toBe("aurora");
  expect((await memberApi.getSettings()).theme).toBe("dawn");
});

it("will not tell the holder of a valid code who is already in the lab", async () => {
  // The email check runs before anything is written or hashed, so a
  // distinct answer here costs an attacker nothing and does not spend the
  // code: one invite becomes an unlimited oracle for whether any address
  // belongs to a member. Both refusals have to read the same.
  const { ownerApi, base } = await lab();
  const redeem = (code: string, email: string) =>
    fetch(`${base}/auth/redeem-invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, email, displayName: "New", password: "a good long password" }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as { error?: string } }));

  const valid = await ownerApi.createInvite("member");
  const knownMember = (await ownerApi.currentUser()).email;

  const probe = await redeem(valid.code, knownMember);
  const nonsense = await redeem("no-such-code", "nobody@lab.example");

  expect(probe.status).toBe(nonsense.status);
  expect(probe.body.error).toBe(nonsense.body.error);
  // And the probe did not spend the code, which is what would have made it
  // self-limiting.
  expect((await ownerApi.listInvites()).map((i) => i.code)).toContain(valid.code);
});

it("refuses an expired invite, a revoked one, and one already used", async () => {
  // Redemption is a pre-auth route, so this goes over HTTP rather than
  // through the contract: there is nobody signed in to call a method as.
  const { ownerApi, base, advanceClock } = await lab();

  const redeem = (code: string, email: string) =>
    fetch(`${base}/auth/redeem-invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, email, displayName: "New", password: "a good long password" }),
    });

  const used = await ownerApi.createInvite("member");
  expect((await redeem(used.code, "first@lab.example")).status).toBe(200);
  // Single use: the second attempt on the same code must not admit anyone.
  expect((await redeem(used.code, "second@lab.example")).status).toBe(400);

  const revoked = await ownerApi.createInvite("member");
  await ownerApi.revokeInvite(revoked.code);
  expect((await redeem(revoked.code, "third@lab.example")).status).toBe(400);

  expect((await redeem("never-minted", "fourth@lab.example")).status).toBe(400);

  // Expiry is time, not state, so the clock moves rather than the invite.
  const expiring = await ownerApi.createInvite("member");
  advanceClock(8 * 24 * 60 * 60);
  expect((await redeem(expiring.code, "fifth@lab.example")).status).toBe(400);

  // Three, not two: the owner and the member `makeServerLab` itself admits
  // through its own invite before the test ever runs, plus the one
  // redemption above that actually succeeded ("first@lab.example"). Every
  // other attempt in this test was refused and admitted nobody.
  expect(await ownerApi.listMembers()).toHaveLength(3);
});

it("keeps a redeemed invite listed with the time it was used, and leaves a fresh one without one", async () => {
  // `makeServerLab` itself admits its member through a real invite, so the
  // roster already has one redeemed code to read back — nothing here needs
  // to mint and redeem one just to have a fixture.
  const { ownerApi } = await lab();
  const fresh = await ownerApi.createInvite("member");

  const invites = await ownerApi.listInvites();
  const used = invites.find((i) => i.code !== fresh.code)!;
  // Same-second in this harness, whose clock does not advance between the
  // mint and the redeem it seeds itself with — greater-or-equal is the
  // honest claim, not greater-than.
  expect(used.redeemedTs).toBeGreaterThanOrEqual(used.createdTs);

  const stillFresh = invites.find((i) => i.code === fresh.code)!;
  // Absent rather than null or undefined-valued, the same convention
  // `removedTs` follows on `Member`: a present key with no value reads as
  // "used" to anything checking for the property.
  expect("redeemedTs" in stillFresh).toBe(false);
});
