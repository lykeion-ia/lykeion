/**
 * The Workflows section, end-to-end against the in-memory lab.
 *
 * A row is a link into `#/workflows/:id`, so opening one is a navigation and
 * everything on the far side of it has to be awaited: the detail screen reads
 * the catalogue itself before it can render a form.
 */

import { afterEach, expect, it } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";

afterEach(cleanup);

async function openWorkflows(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("link", { name: /^Workflows$/i }));
}

it("opens a workflow, builds the prompt, and shows the expansion", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);

  await openWorkflows(user);
  await user.click(
    await screen.findByRole("link", { name: /Differential expression/ }),
  );

  // Fill the required placeholders; top_n keeps its default of 20.
  await user.type(
    await screen.findByLabelText(/Counts matrix/i),
    "counts.csv",
  );
  await user.type(screen.getByLabelText(/Group A/i), "control");
  await user.type(screen.getByLabelText(/Group B/i), "treated");

  await user.click(screen.getByRole("button", { name: /Build prompt/i }));

  expect(await screen.findByTestId("expanded-prompt")).toHaveTextContent(
    "Load counts.csv and run differential expression between control and treated. Report the top 20 genes.",
  );
});

it("surfaces the missing-required error when a required field is blank", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);

  await openWorkflows(user);
  await user.click(
    await screen.findByRole("link", { name: /Differential expression/ }),
  );

  await user.click(await screen.findByRole("button", { name: /Build prompt/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /missing required placeholder/i,
  );
});

it("groups the catalogue by discipline and narrows on a search", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);

  await openWorkflows(user);

  // The seeded catalogue spans several fields, and a row files under the one
  // it declares rather than under whichever heading came first.
  expect(
    await screen.findByRole("heading", { name: /Biology/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Chemistry/ })).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /Molecular docking/ }),
  ).toBeInTheDocument();

  await user.type(screen.getByPlaceholderText(/Search workflows/i), "docking");

  expect(
    screen.getByRole("link", { name: /Molecular docking/ }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /Differential expression/ }),
  ).toBeNull();
  // The heading its one match files under survives; the others go with their
  // rows rather than standing empty.
  expect(screen.getByRole("heading", { name: /Chemistry/ })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /Biology/ })).toBeNull();
});

it("shows only the phases a workflow declares, and names what it skips", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);

  await openWorkflows(user);
  await user.click(
    await screen.findByRole("link", { name: /Literature summary/ }),
  );

  const method = await screen.findByRole("region", { name: /Method phases/i });
  expect(
    within(method).getByRole("list").querySelectorAll("li"),
  ).toHaveLength(3);
  expect(within(method).getByText(/3 of 10 phases/)).toBeInTheDocument();

  // A phase it does not run is named as skipped rather than listed greyed.
  expect(within(method).getByText(/Skips:/)).toHaveTextContent(/Pre-register/);
  expect(within(method).queryByText("Pre-register")).toBeNull();
});

it("creates a workflow from the modal and files it under its discipline", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  render(<App api={api} />);

  await openWorkflows(user);
  await user.click(await screen.findByRole("button", { name: /New workflow/i }));

  const dialog = await screen.findByRole("dialog", {
    name: /Create workflow/i,
  });
  await user.type(
    within(dialog).getByPlaceholderText(/Differential expression/i),
    "Titration curve",
  );
  await user.type(
    within(dialog).getByPlaceholderText(/What this workflow produces/i),
    "Fit a titration curve.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Chemistry" }));
  // `{{` is how a literal brace is typed — a single one opens a key
  // descriptor, and the placeholder would never reach the field.
  await user.type(
    within(dialog).getByPlaceholderText(/Load \{counts_file\}/i),
    "Fit the curve in {{readings}.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Create" }));

  // It reaches the lab with the discipline and phases the form collected,
  // and comes back on the list under that discipline's heading.
  const created = (await api.listWorkflows()).find(
    (w) => w.name === "Titration curve",
  );
  expect(created?.discipline).toBe("chemistry");
  expect(created?.placeholders.map((p) => p.key)).toEqual(["readings"]);
  expect(
    await screen.findByRole("link", { name: /Titration curve/ }),
  ).toBeInTheDocument();
});
