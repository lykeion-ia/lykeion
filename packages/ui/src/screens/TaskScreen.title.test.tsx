/**
 * A chat is named after the message that starts it.
 *
 * The title is an AUTHORED field: minting from a composer writes the truncated
 * prompt, renaming replaces it, and nothing recomputes it afterwards. A chat
 * started from the sidebar's New is minted before there is any prompt to name
 * it from, so it lands under a placeholder — and the first send is where the
 * real title gets written, not where a renderer starts deriving one.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";
import { resetPageLoad } from "../lib/tabs-storage";

const STUDY = "s_cmp";
// A seeded Task with no transcript, so the surface opens on the chat entry.
const FILED = "t_5";

beforeEach(() => {
  cleanup();
  // `App` reads the stored strip once per page; this file mounts it fresh per
  // test. Adopting the incoming hash needs no reset — that is per-mount, in
  // `RouterProvider`.
  resetPageLoad();
});

describe("a chat's title", () => {
  it("takes the first message, replacing the placeholder New mints", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    window.location.hash = `#/studies/${STUDY}/tasks/${FILED}`;
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "New" }));

    // The mint has no prompt to name itself from yet, so it lands under the
    // placeholder. Every chat started this way would otherwise read as the
    // same unlabelled row in the sidebar, the breadcrumb, the board, the
    // Inbox and My Tasks — for the rest of its life.
    const minted = await waitFor(async () => {
      const t = (await api.getStudy(STUDY)).tasks.find(
        (x) => x.title === "New task",
      );
      expect(t).toBeDefined();
      return t!;
    });
    expect(minted.runCount).toBe(0);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "quantify the tuning drift after deprivation",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    // Written, not derived: the record itself carries the new title, which is
    // what every other surface reads.
    await waitFor(async () =>
      expect((await api.getTask(minted.id)).task.title).toBe(
        "quantify the tuning drift after deprivation",
      ),
    );
    // And the surface the researcher is looking at says so too — the Study's
    // own list, which is what names the open conversation now that the
    // breadcrumb no longer carries it as a tab.
    expect(
      await screen.findByRole("button", {
        name: "quantify the tuning drift after deprivation",
        current: "page",
      }),
    ).toBeInTheDocument();
  });

  it("leaves a title somebody authored alone", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const before = (await api.getTask(FILED)).task.title;
    window.location.hash = `#/studies/${STUDY}/tasks/${FILED}`;
    render(<App api={api} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "start with the deprivation cohort",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The send is under way — the message is on screen as the turn's own.
    expect(
      await screen.findByText("start with the deprivation cohort"),
    ).toBeInTheDocument();

    // This Task was named by whoever captured it. A first send is not licence
    // to overwrite that — only the placeholder is up for replacement.
    expect((await api.getTask(FILED)).task.title).toBe(before);
  });
});
