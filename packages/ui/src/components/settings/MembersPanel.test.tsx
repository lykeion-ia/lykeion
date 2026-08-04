import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type Invite, type LykeionApi, type Member } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { InviteRow, MembersPanel } from "./MembersPanel";

afterEach(cleanup);

/** The in-memory lab as `createInMemoryApi()` seeds it: an owner and one
 *  other member (Amara) — the second member every test below needs to have
 *  something in the roster worth telling apart from the owner. */
async function twoMemberLab(): Promise<{ api: LykeionApi; members: Member[] }> {
  const api = createInMemoryApi();
  return { api, members: await api.listMembers() };
}

function renderAs(api: LykeionApi, role: "owner" | "member") {
  return render(
    <ApiProvider api={api}>
      <MembersPanel role={role} />
    </ApiProvider>,
  );
}

it("lists every member, offboarded ones included and marked as such", async () => {
  const { api, members } = await twoMemberLab();
  const other = members.find((m) => m.role === "member");
  // Not a skipped assertion behind an `if`: a seed that ever lost its second
  // member would silently stop running the offboarding half of this test,
  // which is the point of the seed in the first place.
  expect(other).toBeDefined();
  await api.removeMember(other!.user.id);
  renderAs(api, "owner");

  for (const m of await api.listMembers()) {
    expect(await screen.findByText(m.user.displayName)).toBeInTheDocument();
  }
  // Offboarded members stay listed because their authorship stays
  // attributable; the row has to say which they are.
  expect(await screen.findByText(/no longer a member/i)).toBeInTheDocument();
});

it("hides the owner's controls from a member", async () => {
  // The server refuses these calls anyway. Showing the controls offers a
  // member something that can only fail.
  const { api } = await twoMemberLab();
  renderAs(api, "member");

  await screen.findByRole("list", { name: /Members/i });
  expect(screen.queryByRole("button", { name: /Mint an invite/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /Remove/i })).toBeNull();
});

it("shows an owner the control a member is not offered", async () => {
  const { api } = await twoMemberLab();
  renderAs(api, "owner");
  expect(
    await screen.findByRole("button", { name: /Mint an invite/i }),
  ).toBeInTheDocument();
});

it("shows a minted invite's code, because it has to be handed over", async () => {
  const user = userEvent.setup();
  const { api } = await twoMemberLab();
  renderAs(api, "owner");

  await user.click(await screen.findByRole("button", { name: /Mint an invite/i }));

  const minted = await api.listInvites();
  const fresh = minted[minted.length - 1];
  // The code itself, not a confirmation that one exists: an invite nobody
  // can read is an invite nobody can use.
  expect(await screen.findByText(fresh.code)).toBeInTheDocument();
});

it("stops showing an invite once it is withdrawn", async () => {
  const user = userEvent.setup();
  // On a real clock, because withdrawing is offered against a code that can
  // still let somebody in, and the seed's fixture date mints one that
  // expired weeks ago.
  const api = createInMemoryApi(undefined, { now: () => Date.now() / 1000 });
  const invite = await api.createInvite("member");
  renderAs(api, "owner");

  expect(await screen.findByText(invite.code)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: new RegExp(`Withdraw ${invite.code}`, "i") }));

  await waitFor(() => expect(screen.queryByText(invite.code)).toBeNull());
  expect(await api.listInvites()).toEqual([]);
});

/**
 * `listInvites` returns every invite that has not been revoked — a redeemed
 * one still lists, an expired one still lists — so the row itself, not a
 * live lab, is what has to say a code is dead. Driven directly with a
 * fabricated `Invite` because nothing in the contract advances a clock past
 * a week or marks a code redeemed without a second, pre-auth account to do
 * the redeeming; `InviteRow` takes only its props, so this needs neither.
 */
function invite(overrides: Partial<Invite>): Invite {
  return {
    code: "inv_sample",
    role: "member",
    createdBy: "u_owner",
    createdTs: 1,
    expiresTs: Date.now() / 1000 + 1000,
    ...overrides,
  };
}

it("shows a live invite's code with a copy control and no dead-code marker", () => {
  render(<InviteRow invite={invite({ code: "zzz001" })} onWithdraw={() => {}} />);
  expect(screen.getByText("zzz001")).toBeInTheDocument();
  expect(screen.queryByText(/expired/i)).toBeNull();
  expect(screen.queryByText(/already joined/i)).toBeNull();
  expect(screen.getByRole("button", { name: /^Copy/i })).toBeInTheDocument();
});

it("marks an expired invite instead of letting an owner read a dead code as live", () => {
  render(
    <InviteRow
      invite={invite({ code: "zzz002", expiresTs: Date.now() / 1000 - 1 })}
      onWithdraw={() => {}}
    />,
  );
  expect(screen.getByText("zzz002")).toBeInTheDocument();
  expect(screen.getByText(/expired/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Copy/i })).toBeNull();
});

it("marks a redeemed invite as already joined instead of letting an owner read a dead code as live", () => {
  render(
    <InviteRow
      invite={invite({ code: "zzz003", redeemedTs: 5 })}
      onWithdraw={() => {}}
    />,
  );
  expect(screen.getByText("zzz003")).toBeInTheDocument();
  expect(screen.getByText(/already joined/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Copy/i })).toBeNull();
});

it("offers no way to withdraw a code that has already been used", () => {
  render(<InviteRow invite={invite({ code: "zzz004", redeemedTs: 5 })} onWithdraw={() => {}} />);
  expect(screen.queryByRole("button", { name: /Withdraw zzz004/i })).toBeNull();
});

it("keeps spent codes out of the outstanding list without losing them", async () => {
  // A used code under "Outstanding invites" reads as a door still open, and
  // the control beside it as a way to shut one. Both are wrong: it let one
  // person in and is finished. It stays on the page because which code
  // somebody arrived on is worth being able to look up.
  const api = createInMemoryApi(undefined, { now: () => Date.now() / 1000 });
  const usable = await api.createInvite("member");
  const used = await api.createInvite("member");
  const spent = { ...used, redeemedTs: Math.floor(Date.now() / 1000) };
  const listInvites = async (): Promise<Invite[]> => [usable, spent];
  renderAs({ ...api, listInvites }, "owner");

  const outstanding = await screen.findByRole("list", { name: "Outstanding invites" });
  expect(within(outstanding).getByText(usable.code)).toBeInTheDocument();
  expect(within(outstanding).queryByText(spent.code)).toBeNull();

  const dead = screen.getByRole("list", { name: "No longer usable" });
  expect(within(dead).getByText(spent.code)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: `Withdraw ${spent.code}` })).toBeNull();
  expect(screen.getByRole("button", { name: `Withdraw ${usable.code}` })).toBeInTheDocument();
});

it("offboards a member and marks their row, which stays on the roster", async () => {
  const user = userEvent.setup();
  const { api, members } = await twoMemberLab();
  const other = members.find((m) => m.role === "member");
  expect(other).toBeDefined();
  renderAs(api, "owner");

  await user.click(
    await screen.findByRole("button", { name: new RegExp(`Remove ${other!.user.displayName}`, "i") }),
  );

  await waitFor(async () => {
    const roster = await api.listMembers();
    expect(roster.find((m) => m.user.id === other!.user.id)?.removedTs).toBeGreaterThan(0);
  });
  expect(await screen.findByText(/no longer a member/i)).toBeInTheDocument();
});
