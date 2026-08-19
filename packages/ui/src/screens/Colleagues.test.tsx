import { afterEach, expect, it } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed, type Seed } from "@lykeion/api";
import App from "../App";

afterEach(cleanup);

it("opens Colleagues from the rail and lists the lab's own member", async () => {
  render(<App api={createInMemoryApi(emptySeed())} />);
  await userEvent.click(
    await screen.findByRole("link", { name: /^Colleagues$/i }),
  );
  expect(await screen.findByRole("heading", { name: /^Colleagues$/i }))
    .toBeInTheDocument();
  expect(await screen.findByText("You")).toBeInTheDocument();
});

it("shows a colleague's open work, researches and machines", async () => {
  const seed = emptySeed();
  const api = createInMemoryApi(seed);
  const research = await api.createResearch({ title: "Compounds", key: "CMP" });
  await api.createTask({
    researchId: research.id,
    stage: "background",
    title: "Dose–response",
    assignees: [{ kind: "user", userId: "u_you" }],
  });

  render(<App api={api} />);
  await userEvent.click(
    await screen.findByRole("link", { name: /^Colleagues$/i }),
  );
  expect(await screen.findByText(/1 open/)).toBeInTheDocument();
  expect(await screen.findByText("CMP")).toBeInTheDocument();
});

it("says so plainly when a colleague has nothing open", async () => {
  render(<App api={createInMemoryApi(emptySeed())} />);
  await userEvent.click(
    await screen.findByRole("link", { name: /^Colleagues$/i }),
  );
  expect(await screen.findByText(/Nothing open/)).toBeInTheDocument();
});

/** A lab with an owner and one plain member, seen through the member's eyes. */
function seedAsMember(): Seed {
  const base = emptySeed();
  const owner = base.users[0];
  const mate = {
    id: "u_mate",
    email: "mate@lab.example",
    displayName: "Mate",
    createdTs: 0,
  };
  return {
    ...base,
    users: [owner, mate],
    members: [
      { user: owner, role: "owner", joinedTs: 0 },
      { user: mate, role: "member", joinedTs: 0 },
    ],
    me: mate.id,
  };
}

it("offers no invite and no removal to a plain member", async () => {
  render(<App api={createInMemoryApi(seedAsMember())} />);
  await userEvent.click(
    await screen.findByRole("link", { name: /^Colleagues$/i }),
  );
  await screen.findByText("Mate");
  expect(screen.queryByRole("button", { name: /Invite/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Remove /i })).toBeNull();
});

it("offers an owner the invite modal, and will not let them remove themselves", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("link", { name: /^Colleagues$/i }));

  // The sole owner is also the only member, so no Remove may be offered:
  // not on yourself, and not on the last owner.
  await screen.findByText("You");
  expect(screen.queryByRole("button", { name: /^Remove /i })).toBeNull();

  await user.click(await screen.findByRole("button", { name: /Invite/i }));
  const dialog = await screen.findByRole("dialog", {
    name: /Invite a colleague/i,
  });
  await user.click(
    within(dialog).getByRole("button", { name: /Mint a code/i }),
  );
  expect(
    await within(dialog).findByText(/member invite/i),
  ).toBeInTheDocument();
});

it("keeps an offboarded colleague listed, marked, and beyond removal", async () => {
  const base = emptySeed();
  const owner = base.users[0];
  const gone = {
    id: "u_gone",
    email: "gone@lab.example",
    displayName: "Gone",
    createdTs: 0,
  };
  const api = createInMemoryApi({
    ...base,
    users: [owner, gone],
    members: [
      { user: owner, role: "owner", joinedTs: 0 },
      { user: gone, role: "member", joinedTs: 0, removedTs: 1 },
    ],
  });

  render(<App api={api} />);
  await userEvent.click(
    await screen.findByRole("link", { name: /^Colleagues$/i }),
  );
  expect(await screen.findByText("Gone")).toBeInTheDocument();
  expect(await screen.findByText(/No longer a member/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Remove Gone$/i })).toBeNull();
});

it("offboards a colleague and marks their row, which stays on the roster", async () => {
  const user = userEvent.setup();
  // The default seed, not the empty one: this needs a second member to
  // remove, and removing the only owner is refused by design.
  const api = createInMemoryApi();
  const other = (await api.listMembers()).find((m) => m.role === "member");
  expect(other).toBeDefined();

  render(<App api={api} />);
  await user.click(await screen.findByRole("link", { name: /^Colleagues$/i }));
  await user.click(
    await screen.findByRole("button", {
      name: new RegExp(`Remove ${other!.user.displayName}`, "i"),
    }),
  );

  await waitFor(async () => {
    const roster = await api.listMembers();
    expect(
      roster.find((m) => m.user.id === other!.user.id)?.removedTs,
    ).toBeGreaterThan(0);
  });
  expect(await screen.findByText(/No longer a member/i)).toBeInTheDocument();
});

it("reports a failed mint inside the dialog, where the control that failed is", async () => {
  const user = userEvent.setup();
  const base = createInMemoryApi(emptySeed());
  // The dialog covers the viewport, so an error the screen behind it renders
  // is an error nobody minting can read.
  const api = {
    ...base,
    createInvite: async () => {
      throw new Error("the lab refused that");
    },
  };

  render(<App api={api} />);
  await user.click(await screen.findByRole("link", { name: /^Colleagues$/i }));
  await user.click(await screen.findByRole("button", { name: /Invite/i }));

  const dialog = await screen.findByRole("dialog", {
    name: /Invite a colleague/i,
  });
  await user.click(
    within(dialog).getByRole("button", { name: /Mint a code/i }),
  );

  expect(
    await within(dialog).findByText(/the lab refused that/i),
  ).toBeInTheDocument();

  // And it goes with the dialog: the screen's own line speaks for Remove, so
  // an invite failure left in state would surface there against the wrong
  // control.
  await user.click(within(dialog).getByRole("button", { name: /Close/i }));
  await waitFor(() =>
    expect(screen.queryByText(/the lab refused that/i)).toBeNull(),
  );
});
