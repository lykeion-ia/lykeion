/**
 * Review fix — an externally-set draft must grow the composer too.
 *
 * `autoGrow` used to run only from the textarea's own `onChange`, so when a
 * controlling parent sets `draft` imperatively (the Task surface's Edit,
 * refilling the composer from a past prompt) the height was never
 * recomputed: a tall edited prompt sat at `rows={1}` with internal scroll
 * until the researcher typed a key.
 *
 * jsdom never lays text out — `scrollHeight` reads 0 forever — so this
 * drives the same synthetic-layout trick `useStickToBottom.test.tsx` and
 * `TaskScreen.stick.test.tsx` use for the transcript's scroll geometry:
 * stub `scrollHeight` via `Object.defineProperty`, then assert the CSS
 * height `autoGrow` derives from it, rather than asserting a real pixel
 * value jsdom could never produce on its own.
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";

afterEach(cleanup);

function stubScrollHeight(el: HTMLElement, height: number) {
  Object.defineProperty(el, "scrollHeight", {
    value: height,
    configurable: true,
  });
}

/** The shape the Task surface uses for Edit: the draft lives in the PARENT
 *  and is set imperatively — never through the textarea's own `onChange`. */
function ControlledHarness() {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <Composer
        variant="docked"
        onSend={() => {}}
        draft={draft}
        onDraftChange={setDraft}
      />
      <button type="button" onClick={() => setDraft("a".repeat(300))}>
        Refill
      </button>
    </div>
  );
}

describe("Composer autoGrow", () => {
  it("resizes the textarea when the draft is set externally, not just on keystroke", () => {
    render(<ControlledHarness />);
    const textarea = screen.getByLabelText(
      "Message the agent",
    ) as HTMLTextAreaElement;
    stubScrollHeight(textarea, 140);

    // No keystroke ever touches the textarea — the parent sets `draft`
    // directly, exactly as Edit does.
    fireEvent.click(screen.getByRole("button", { name: "Refill" }));

    expect(textarea.value).toBe("a".repeat(300));
    // Reflects the (stubbed) scrollHeight the effect just read, not the
    // single-row default it would be stuck at without the fix.
    expect(textarea.style.height).toBe("140px");
  });

  it("still grows on ordinary typing (uncontrolled), unchanged by the fix", () => {
    render(<Composer variant="docked" onSend={() => {}} />);
    const textarea = screen.getByLabelText(
      "Message the agent",
    ) as HTMLTextAreaElement;
    stubScrollHeight(textarea, 90);

    fireEvent.change(textarea, { target: { value: "hello" } });

    expect(textarea.style.height).toBe("90px");
  });
});

/**
 * The composer's `@`/`#`/`/` reference affordances — three composer hints
 * that live in the textarea (⌘K is the app-wide palette).
 *
 * The sources are supplied by the SCREEN, from things that really exist; these
 * tests cover the mechanism: when a trigger opens a menu, when it must NOT, and
 * that choosing an item inserts a usable reference.
 */
describe("Composer mentions", () => {
  const MENTIONS = [
    {
      trigger: "@" as const,
      label: "Artifacts",
      items: [
        { label: "kinome_genes.csv", description: "522 rows" },
        { label: "offtarget_report.csv" },
      ],
    },
    { trigger: "#" as const, label: "Tasks", items: [{ label: "Guide QC" }] },
    {
      trigger: "/" as const,
      label: "Skills",
      items: [{ label: "sgrna-design" }],
    },
  ];

  const setup = () => {
    const onSend = vi.fn();
    render(<Composer variant="docked" onSend={onSend} mentions={MENTIONS} />);
    return { onSend, input: screen.getByLabelText("Message the agent") };
  };

  it("opens the artifact menu on `@` and filters as you type", async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.type(input, "look at @kin");
    const menu = await screen.findByTestId("mention-menu");
    expect(menu).toHaveTextContent("Artifacts");
    expect(menu).toHaveTextContent("kinome_genes.csv");
    // The non-matching artifact is filtered out.
    expect(menu).not.toHaveTextContent("offtarget_report.csv");
  });

  it("inserts the chosen reference and closes the menu", async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.type(input, "look at @kin");
    await user.click(await screen.findByRole("option", { name: /kinome/ }));
    expect(input).toHaveValue("look at @kinome_genes.csv ");
    expect(screen.queryByTestId("mention-menu")).toBeNull();
  });

  it("completes with Enter instead of sending the message", async () => {
    const user = userEvent.setup();
    const { onSend, input } = setup();
    await user.type(input, "check /sg");
    await screen.findByTestId("mention-menu");
    await user.keyboard("{Enter}");
    // Completion consumed the Enter; the message was NOT sent.
    expect(input).toHaveValue("check /sgrna-design ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not trigger mid-word — an email or a path opens nothing", async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.type(input, "mail me@example");
    expect(screen.queryByTestId("mention-menu")).toBeNull();
    await user.clear(input);
    // A `/` inside a path is not a skill trigger.
    await user.type(input, "read data/raw");
    expect(screen.queryByTestId("mention-menu")).toBeNull();
  });

  it("offers no menu for a source with nothing in it", async () => {
    const user = userEvent.setup();
    render(
      <Composer
        variant="docked"
        onSend={() => {}}
        mentions={[{ trigger: "@", label: "Artifacts", items: [] }]}
      />,
    );
    await user.type(screen.getByLabelText("Message the agent"), "see @");
    expect(screen.queryByTestId("mention-menu")).toBeNull();
  });

  it("sends normally when no mention is active", async () => {
    const user = userEvent.setup();
    const { onSend, input } = setup();
    await user.type(input, "just run it{Enter}");
    expect(onSend).toHaveBeenCalledWith("just run it", { planMode: false });
  });
});

/**
 * `blocker` — what a caller sets when it knows a send has nothing to reach
 * (a real lab with no daemon registered; see `useRuntimeBlocker`). The
 * component itself owns no api and no notion of a runtime: it only renders
 * whatever `ReactNode` it is given and stops the send paths while it is set,
 * which is what these three tests are here to pin down.
 */
describe("Composer blocker", () => {
  const NOTICE =
    "No runtime is connected to this lab. Install the Lykeion daemon on " +
    "the machine you want to run on, and it will appear here.";

  it("says no runtime is connected rather than offering a send that cannot work", () => {
    render(<Composer variant="docked" onSend={() => {}} blocker={NOTICE} />);

    expect(screen.getByText(/no runtime is connected/i)).toBeInTheDocument();
    expect(
      screen.getByText(/install the Lykeion daemon/i),
    ).toBeInTheDocument();
  });

  it("does not let a send be submitted while no runtime is connected", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer variant="docked" onSend={onSend} blocker={NOTICE} />);

    await user.type(
      screen.getByLabelText("Message the agent"),
      "run the alignment{Enter}",
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("composes normally once a runtime has registered", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    // No `blocker` — the shape a caller passes once `listRuntimes()` is no
    // longer empty.
    render(<Composer variant="docked" onSend={onSend} />);

    await user.type(
      screen.getByLabelText("Message the agent"),
      "run the alignment{Enter}",
    );
    expect(onSend).toHaveBeenCalledWith("run the alignment", {
      planMode: false,
    });
    expect(screen.queryByText(/no runtime is connected/i)).toBeNull();
  });
});
