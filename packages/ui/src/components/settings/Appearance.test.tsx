import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import {
  installLocalStorage,
  restoreLocalStorage,
} from "../../test/local-storage";
import App from "../../App";

// The theme is remembered in storage precisely so it outlives a tab, which is
// what makes it leak between tests unless each case starts with its own.
beforeEach(installLocalStorage);

afterEach(() => {
  cleanup();
  // ThemeProvider stamps <html data-theme>; reset it so tests don't leak.
  delete document.documentElement.dataset.theme;
  restoreLocalStorage();
  document.querySelector('meta[name="lykeion-workspace"]')?.remove();
});

/** Open Settings › Appearance and pick a theme by name. */
async function pickTheme(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
) {
  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));
  await user.click(await screen.findByRole("button", { name: "Appearance" }));
  await user.click(screen.getByRole("button", { name }));
}

/**
 * What a browser refresh does to this app: the whole tree goes, and with no
 * workspace server behind the page `selectApi` builds a brand-new in-browser
 * core from seed — which is precisely why nothing the old one held survives.
 */
function reload() {
  cleanup();
  delete document.documentElement.dataset.theme;
  render(<App api={createInMemoryApi(emptySeed())} />);
}

it("lists every theme under Settings › Appearance and applies + persists a pick", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi(emptySeed());
  render(<App api={api} />);

  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));
  await user.click(await screen.findByRole("button", { name: "Appearance" }));

  // All five theme cards render as pressable buttons.
  for (const name of ["Midnight", "Ash", "Dawn", "Pale", "Barbie Dreamhouse"]) {
    expect(
      await screen.findByRole("button", { name: new RegExp(name, "i") }),
    ).toBeInTheDocument();
  }

  // Picking Ash applies it to <html> immediately and persists through the core.
  await user.click(screen.getByRole("button", { name: /Ash/i }));
  expect(document.documentElement.dataset.theme).toBe("ash");
  expect((await api.getSettings()).theme).toBe("ash");
});

it("keeps the chosen theme across a browser refresh", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);

  await pickTheme(user, /Barbie Dreamhouse/i);
  expect(document.documentElement.dataset.theme).toBe("barbie");

  reload();

  await vi.waitFor(() =>
    expect(document.documentElement.dataset.theme).toBe("barbie"),
  );
});

it("ignores a stored theme the catalog no longer offers", async () => {
  localStorage.setItem("lykeion.theme", "vaporwave");
  render(<App api={createInMemoryApi(emptySeed())} />);

  await screen.findByRole("link", { name: /^Settings$/i });
  expect(document.documentElement.dataset.theme).toBe("midnight");
});

it("a real lab's answer outranks what this browser remembers", async () => {
  // hasWorkspaceServer() reads the stamp the server puts on the document it
  // serves; with one present the provider must defer to the lab's record.
  const meta = document.createElement("meta");
  meta.setAttribute("name", "lykeion-workspace");
  document.head.append(meta);
  localStorage.setItem("lykeion.theme", "barbie");

  const api = createInMemoryApi(emptySeed());
  await api.setTheme("dawn");
  render(<App api={api} />);

  await vi.waitFor(() =>
    expect(document.documentElement.dataset.theme).toBe("dawn"),
  );
});
