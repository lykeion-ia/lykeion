/**
 * What a member can reach through the event stream, as opposed to through
 * the contract. The stream is the one surface that answers a caller without
 * going through a contract method, so the guards a method carries do not
 * apply to it — anything the change log holds reaches everyone watching, and
 * a stream resolves who is behind it once and never asks again.
 */
import { afterEach, expect, it } from "vitest";
import { makeServerLab, type Lab } from "../test-support/test-lab";

const labs: Lab[] = [];
const controllers: AbortController[] = [];

async function lab(): Promise<Lab> {
  const made = await makeServerLab();
  labs.push(made);
  return made;
}

afterEach(async () => {
  for (const c of controllers.splice(0)) c.abort();
  for (const l of labs.splice(0)) await l.close();
});

/** Collect whole SSE frames until `settle` has passed with none arriving. */
async function readStream(base: string, cookie: string, settle = 150): Promise<string> {
  const controller = new AbortController();
  controllers.push(controller);
  const res = await fetch(`${base}/events?cursor=0`, {
    headers: { cookie },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const next = reader.read().then((r) => r, () => ({ done: true, value: undefined }));
    const timed = await Promise.race([
      next,
      new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), settle)),
    ]);
    if (timed === "quiet") break;
    if (timed.done) break;
    text += decoder.decode(timed.value, { stream: true });
  }
  controller.abort();
  return text;
}

it("never puts an invite code on the change stream every member is reading", async () => {
  // `listInvites` is the owner's alone, and the code is a credential: an
  // owner-role code read off the stream is redeemable by whoever read it,
  // which makes a member an owner. The guard on the method means nothing if
  // the same secret arrives by another road.
  const { ownerApi, base, memberCookie } = await lab();
  const invite = await ownerApi.createInvite("owner");

  const seen = await readStream(base, memberCookie);

  expect(seen).toContain("invite-created");
  expect(seen).not.toContain(invite.code);
});

it("tells the lab when somebody joins, not only when they are invited", async () => {
  // Minting the invite is a change and reaches the stream; the redemption is
  // the one that matters, and it happens on a route with nobody signed in.
  // Without it an owner watching the roster sees the invite stay outstanding
  // and the new member never arrive, until they reload.
  const { ownerApi, base, cookie } = await lab();
  const invite = await ownerApi.createInvite("member");

  // The lab already admitted one member when it was built, so this counts
  // rather than asks whether the kind has ever appeared.
  const joins = (text: string) => text.split("member-joined").length - 1;
  const before = await readStream(base, cookie);

  const redeemed = await fetch(`${base}/auth/redeem-invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: invite.code,
      email: "newcomer@lab.example",
      displayName: "Newcomer",
      password: "a good long password",
    }),
  });
  expect(redeemed.status).toBe(200);

  const after = await readStream(base, cookie);
  expect(joins(after)).toBe(joins(before) + 1);
  expect(after).toContain("invite-redeemed");
  // And the code itself still never travels, the way it does not on minting.
  expect(after).not.toContain(invite.code);
});

it("refuses an auth call that is not JSON, whatever it says it is", async () => {
  // `text/plain` needs no CORS preflight, so without this any page open in
  // the researcher's browser could drive these routes — creating the owner
  // of a lab nobody has set up yet, or signing them out of one.
  const { base } = await lab();
  const res = await fetch(`${base}/auth/signout`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: "{}",
  });
  expect(res.status).toBe(415);
});

it("cuts off a member's open stream when they are offboarded", async () => {
  // Their next request is refused, but a stream they already hold has no
  // next request — it resolved them at the moment it opened. Left running,
  // an offboarded member goes on watching everything the lab does.
  const { ownerApi, memberId, base, memberCookie } = await lab();
  const controller = new AbortController();
  controllers.push(controller);
  const res = await fetch(`${base}/events`, {
    headers: { cookie: memberCookie },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();

  await ownerApi.removeMember(memberId);

  // The read resolves rather than hanging: the server ended the response.
  const ended = await Promise.race([
    reader.read().then(({ done }) => (done ? "ended" : "still-open")),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  expect(ended).toBe("ended");
});
