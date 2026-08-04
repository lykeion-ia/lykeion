import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import App from "../App";

const CMP = "Cross-modal plasticity in the brain";

afterEach(cleanup);

it("Studies renders the empty state on a fresh install", async () => {
  render(<App api={createInMemoryApi(emptySeed())} />);
  expect(
    await screen.findByText(
      /No studies yet — create one to start a research line\./i,
    ),
  ).toBeInTheDocument();
});

it("Studies lists seeded studies with their key badge", async () => {
  render(<App api={createInMemoryApi()} />);
  expect(await screen.findByText(CMP)).toBeInTheDocument();
  expect(screen.getByText("CMP")).toBeInTheDocument();
});

it("the row's pencil renames the Study in place", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  render(<App api={api} />);

  await user.click(
    await screen.findByRole("button", { name: `Rename ${CMP}` }),
  );
  const input = screen.getByRole("textbox", { name: `Rename ${CMP}` });
  await user.clear(input);
  await user.type(input, "Auditory remapping{Enter}");

  expect(await screen.findByText("Auditory remapping")).toBeInTheDocument();
  expect(screen.queryByText(CMP)).not.toBeInTheDocument();
  // The key badge is not part of a rename.
  expect(screen.getByText("CMP")).toBeInTheDocument();
  expect(
    (await api.listStudies()).find((s) => s.key === "CMP")?.title,
  ).toBe("Auditory remapping");
});

it("Escape leaves the title alone", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);

  await user.click(
    await screen.findByRole("button", { name: `Rename ${CMP}` }),
  );
  const input = screen.getByRole("textbox", { name: `Rename ${CMP}` });
  await user.clear(input);
  await user.type(input, "Discarded{Escape}");

  expect(await screen.findByText(CMP)).toBeInTheDocument();
  expect(screen.queryByText("Discarded")).not.toBeInTheDocument();
});

it("the row's bin deletes the Study, but only through the confirm", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  render(<App api={api} />);

  // Cancelling leaves the Study exactly where it was.
  await user.click(
    await screen.findByRole("button", { name: `Delete ${CMP}` }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Delete study" });
  expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByText(CMP)).toBeInTheDocument();

  // Confirming drops it from the table and from the core.
  await user.click(screen.getByRole("button", { name: `Delete ${CMP}` }));
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Delete study" }),
    ).getByRole("button", { name: "Delete" }),
  );

  await waitForGone(CMP);
  expect((await api.listStudies()).some((s) => s.title === CMP)).toBe(false);
});

/** The row leaves on the screen's re-read, one tick after the delete lands. */
async function waitForGone(text: string) {
  await vi.waitFor(() =>
    expect(screen.queryByText(text)).not.toBeInTheDocument(),
  );
}

/** Open the Filter menu and pick an option under one of its dimensions. */
async function filterBy(
  user: ReturnType<typeof userEvent.setup>,
  dimension: RegExp,
  option: RegExp,
) {
  await user.click(screen.getByRole("button", { name: /^Filter/ }));
  // The dimension rows unmount on drill-in, so the same pattern can name the
  // row and then the option without colliding.
  await user.click(await screen.findByRole("button", { name: dimension }));
  await user.click(await screen.findByRole("button", { name: option }));
}

it("archives a Study out of the list, and shows it again on request", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  render(<App api={api} />);

  await user.click(
    await screen.findByRole("button", { name: `Archive ${CMP}` }),
  );
  await waitForGone(CMP);

  await filterBy(user, /^Archived$/, /^Archived 1$/);
  expect(await screen.findByText(CMP)).toBeInTheDocument();
});

it("the archived filter leaves a chip that puts the Study back when removed", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await screen.findByText(CMP);

  await filterBy(user, /^Archived$/, /^Archived 0$/);
  await waitForGone(CMP);

  await user.click(screen.getByRole("button", { name: "Remove Archived" }));
  expect(await screen.findByText(CMP)).toBeInTheDocument();
});

it("an empty archive says so rather than going blank", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await screen.findByText(CMP);

  await filterBy(user, /^Archived$/, /^Archived 0$/);

  expect(
    await screen.findByText(/No studies match these filters\./i),
  ).toBeInTheDocument();
});
