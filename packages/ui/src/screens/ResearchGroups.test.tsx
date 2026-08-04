import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import App from "../App";

afterEach(cleanup);

it("shows the empty state on a fresh install", async () => {
  render(<App api={createInMemoryApi(emptySeed())} />);
  await userEvent.click(
    await screen.findByRole("link", { name: /Research Groups/i }),
  );
  expect(
    await screen.findByText(/No research groups yet/i),
  ).toBeInTheDocument();
});

it("creates a research group via the modal and lists it", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(
    await screen.findByRole("link", { name: /Research Groups/i }),
  );

  await user.click(
    await screen.findByRole("button", { name: /New Research Group/i }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: /Create research group/i,
  });
  await user.type(
    within(dialog).getByPlaceholderText(/Structural Biology/i),
    "Genomics Core",
  );
  await user.click(
    within(dialog).getByRole("button", { name: /^Create research group$/i }),
  );

  expect(await screen.findByText("Genomics Core")).toBeInTheDocument();
});
