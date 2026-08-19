import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invite } from "@lykeion/api";
import { InviteModal, InviteRow } from "./InviteModal";

afterEach(cleanup);

/** A live code unless the override says otherwise. These tests are about how
 *  a code's state is reported, so every one of them varies exactly one
 *  field of it. */
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

const noop = async () => {};

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
  render(
    <InviteRow
      invite={invite({ code: "zzz004", redeemedTs: 5 })}
      onWithdraw={() => {}}
    />,
  );
  expect(screen.queryByRole("button", { name: /Withdraw zzz004/i })).toBeNull();
});

it("keeps spent codes out of the outstanding list without losing them", () => {
  // A used code under "Outstanding" reads as a door still open, and the
  // control beside it as a way to shut one. Both are wrong: it let one person
  // in and is finished. It stays on the page because which code somebody
  // arrived on is worth being able to look up.
  const usable = invite({ code: "live01" });
  const spent = invite({ code: "used01", redeemedTs: 5 });
  render(
    <InviteModal
      invites={[usable, spent]}
      onMint={noop}
      onWithdraw={noop}
      onClose={() => {}}
    />,
  );

  const outstanding = screen.getByRole("list", { name: "Outstanding invites" });
  expect(within(outstanding).getByText("live01")).toBeInTheDocument();
  expect(within(outstanding).queryByText("used01")).toBeNull();

  const dead = screen.getByRole("list", { name: "No longer usable" });
  expect(within(dead).getByText("used01")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Withdraw used01/i })).toBeNull();
  expect(
    screen.getByRole("button", { name: /Withdraw live01/i }),
  ).toBeInTheDocument();
});

it("withdraws the code the control names, not whichever came first", async () => {
  const user = userEvent.setup();
  const onWithdraw = vi.fn(async () => {});
  render(
    <InviteModal
      invites={[invite({ code: "aaa111" }), invite({ code: "bbb222" })]}
      onMint={noop}
      onWithdraw={onWithdraw}
      onClose={() => {}}
    />,
  );

  await user.click(screen.getByRole("button", { name: /Withdraw bbb222/i }));
  expect(onWithdraw).toHaveBeenCalledWith("bbb222");
});

it("says so plainly when there is nothing outstanding", () => {
  render(
    <InviteModal
      invites={[]}
      onMint={noop}
      onWithdraw={noop}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText(/No invites outstanding/i)).toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "No longer usable" })).toBeNull();
});
