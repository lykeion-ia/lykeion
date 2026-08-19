/**
 * The researcher's own message must render in the conversation.
 *
 * Regression guard for a bug where only the agent's `assistant-text` was ever
 * shown: the prompt was forwarded to `startRun` and dropped from the UI, so the
 * user's turn never appeared in the stream. Drives a real run through the
 * in-memory `LykeionApi`; role/text-based, agnostic to the markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";

// CMP-3 is in-review, so it opens straight into the full chat interface.
const CMP3 = "#/researches/s_cmp/tasks/t_3";

beforeEach(cleanup);

describe("User message rendering", () => {
  it("shows the researcher's own message in the conversation after sending", async () => {
    const user = userEvent.setup();
    window.location.hash = CMP3;
    render(<App api={createInMemoryApi()} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "count the tuned neurons",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The user's own prompt must appear in the conversation stream — not just
    // the agent's replies.
    const conversation = await screen.findByTestId("conversation");
    expect(
      within(conversation).getByText("count the tuned neurons"),
    ).toBeInTheDocument();
  });
});
