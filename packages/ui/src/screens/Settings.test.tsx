import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import App from "../App";

// Skills and Connectors are managed here, under Settings › Capabilities —
// they are configuration, not workspace content, so they left the Rail.

afterEach(cleanup);

it("renders the settings nav and the General tab's lab sections", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));

  // A settings-nav group + item. "Capabilities" and a settings-nav button are
  // both unique to this pane, so neither can be answered by the Rail behind it.
  expect(await screen.findByText("Capabilities")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Credentials" }),
  ).toBeInTheDocument();
  // General tab is the default; it names itself the way every other tab does,
  // then answers for the lab's models and licensing.
  expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Model" })).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Licensing" }),
  ).toBeInTheDocument();
  // Account is the Profile tab's now, not General's — one home for a face.
  expect(screen.queryByRole("heading", { name: "Account" })).toBeNull();
});

it("renders the Skills and Connectors tabs under Capabilities", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />); // default seed has skills
  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));

  await screen.findByText("Capabilities"); // settings pane is mounted
  expect(screen.getByRole("button", { name: "Skills" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Connectors" }),
  ).toBeInTheDocument();

  // The Skills panel renders intact — its own title row CTA and a seeded row.
  await user.click(screen.getByRole("button", { name: "Skills" }));
  expect(
    await screen.findByRole("button", { name: /Add skill/i }),
  ).toBeInTheDocument();
  expect(await screen.findByText("rnaseq")).toBeInTheDocument();

  // And so does Connectors, with both of its sections.
  await user.click(screen.getByRole("button", { name: "Connectors" }));
  expect(await screen.findByTestId("your-connectors")).toBeInTheDocument();
  expect(screen.getByTestId("connector-catalog")).toBeInTheDocument();
});

it("deep-links a Settings tab through the route", async () => {
  window.location.hash = "#/settings/connectors";
  render(<App api={createInMemoryApi()} />);

  expect(await screen.findByTestId("connector-catalog")).toBeInTheDocument();
  window.location.hash = "";
});

/**
 * Every tab's title must sit in the same place. jsdom has no layout engine, so
 * this pins the *structure* that produces the position — which only works if
 * it captures every way a title can move. Two of them:
 *
 *  1. something between the title and the pane adds padding/margin;
 *  2. the title shares a row with a taller in-flow sibling (a 32px `h-8` CTA
 *     next to a ~22px heading drives the row height and, under `items-center`,
 *     shoves the title ~5px down).
 *
 * (2) is why Skills and Connectors were visibly low. The guard is therefore
 * that the heading is the ONLY in-flow thing in its block: any sibling on the
 * way up to the pane must be absolutely positioned.
 */
it("leads every tab's title at the same position", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));

  const pane = () => screen.getByTestId("settings-body");
  // Classes that would shift a title relative to the pane's own px-6 py-5.
  const offsets = /^(p|m)(t|y|l|x)?-/;

  const titleGeometry = async (tab: string) => {
    await user.click(screen.getByRole("button", { name: tab }));
    const heading = await screen.findByRole("heading", { name: tab });

    const strays: string[] = [];
    const inFlowSiblings: string[] = [];
    let gaps = 0;
    let el: HTMLElement | null = heading;
    for (; el && el !== pane(); el = el.parentElement) {
      for (const c of el.classList) {
        if (c === "mb-3") gaps++;
        else if (offsets.test(c)) strays.push(c);
      }
      // A block sibling below the title is harmless; a sibling sharing a flex
      // ROW is not — it can drive the row's height and, under items-center,
      // push the title off the shared baseline. Flag only the latter.
      const holder: HTMLElement | null = el.parentElement;
      const isFlexRow =
        !!holder &&
        holder.classList.contains("flex") &&
        !holder.classList.contains("flex-col");
      if (holder && isFlexRow) {
        for (const sib of Array.from(holder.children)) {
          if (sib !== el && !sib.classList.contains("absolute")) {
            inFlowSiblings.push(sib.tagName.toLowerCase());
          }
        }
      }
      if (holder === pane()) break;
    }
    return {
      tag: heading.tagName,
      type: [...heading.classList].filter((c) => c !== "mb-3").sort(),
      strays,
      gaps,
      inFlowSiblings,
    };
  };

  const memory = await titleGeometry("Memory");
  expect(memory.strays).toEqual([]);
  expect(memory.gaps).toBe(1);
  expect(memory.inFlowSiblings).toEqual([]);

  for (const tab of ["Skills", "Connectors"]) {
    const got = await titleGeometry(tab);
    expect(got.tag).toBe(memory.tag);
    expect(got.type).toEqual(memory.type);
    expect(got.strays).toEqual([]);
    expect(got.gaps).toBe(1);
    // The CTA must not share the title's row.
    expect(got.inFlowSiblings).toEqual([]);
  }
});

/**
 * A tab titles itself one size up from the sections inside it. Asserted on the
 * type class rather than on a measured size, because jsdom has no layout
 * engine — but a tab title and a section title resolving to the same class is
 * exactly the regression this guards: the two were one size, which left
 * "Profile" and the "Account" under it reading as equals with no top to the
 * tab. Any refactor that folds them back together fails here.
 */
it("titles a tab a size above the sections inside it", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));
  await user.click(await screen.findByRole("button", { name: "Profile" }));

  const typeOf = (name: string) =>
    [...screen.getByRole("heading", { name }).classList]
      .filter((c) => c.startsWith("text-["))
      .join(" ");

  // The Profile tab carries both levels at once, so one render settles it.
  const tab = typeOf("Profile");
  expect(tab).not.toBe("");
  for (const section of ["Account", "Usage"]) {
    expect(typeOf(section)).not.toBe(tab);
  }
  // And every tab titles itself with the same one, whichever tab it is.
  await user.click(screen.getByRole("button", { name: "General" }));
  expect(typeOf("General")).toBe(tab);
});

it("says disk usage is unmeasured rather than perpetually in progress", async () => {
  // Nothing reports the lab's footprint, so nothing is under way. A line
  // that reads as work in flight is a wait with nothing at the end of it,
  // and it is indistinguishable on screen from a screen that has hung.
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));
  await user.click(await screen.findByRole("button", { name: "Storage" }));

  expect(await screen.findByRole("heading", { name: "Disk usage" })).toBeInTheDocument();
  expect(screen.queryByText(/scanning/i)).toBeNull();
  expect(screen.getByText(/not measured/i)).toBeInTheDocument();
});
