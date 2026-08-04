import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import App from "../App";

// Skills live under Settings › Capabilities (they left the Rail); the panel
// itself renders exactly as it did as a standalone screen.

afterEach(cleanup);

/** Rail › Settings, then the Skills tab in the settings nav. */
async function openSkills(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));
  await user.click(await screen.findByRole("button", { name: "Skills" }));
}

it("Skills empty state on a fresh install", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await openSkills(user);
  expect(await screen.findByText(/No skills yet/i)).toBeInTheDocument();
});

it("creates a skill from the Add › Write from scratch form", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await openSkills(user);

  await user.click(screen.getByRole("button", { name: /Add skill/i }));
  await user.click(
    screen.getByRole("menuitem", { name: /Write from scratch/i }),
  );

  await user.type(screen.getByPlaceholderText(/e\.g\. gsea/i), "gsea");
  await user.click(screen.getByRole("button", { name: /Create skill/i }));

  expect(await screen.findByText("gsea")).toBeInTheDocument();
});

it("opens Skills directly from the #/skills alias", async () => {
  window.location.hash = "#/skills";
  render(<App api={createInMemoryApi(emptySeed())} />);

  // The panel's own title row renders inside the settings surface.
  expect(
    await screen.findByRole("button", { name: /Add skill/i }),
  ).toBeInTheDocument();
  expect(await screen.findByText(/No skills yet/i)).toBeInTheDocument();
  window.location.hash = "";
});
