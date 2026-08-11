/**
 * The agent named at the head of a Task — the brand mark of the coding CLI
 * its turns ran on, and the brand's own name for itself.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AgentLabel } from "./AgentLabel";

beforeEach(cleanup);

describe("AgentLabel", () => {
  it("names the agent and draws its mark", () => {
    const { container } = render(<AgentLabel agent="codex" />);

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("renders nothing for a Task no agent has run", () => {
    // A Task nobody has spoken in is on no agent, and an empty strip is the
    // honest drawing of that rather than a placeholder standing in for one.
    const { container } = render(<AgentLabel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("prefers the name detection reported over the one it knows", () => {
    // The machine that found the CLI is the better authority on what it is
    // called; the built-in table is what answers when there is none.
    render(<AgentLabel agent="claude" name="Claude Code" />);

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.queryByText("Claude")).toBeNull();
  });

  it("falls back to a monogram for a brand with no mark bundled", () => {
    // Gemini has no public brand mark, so the name carries the identity and
    // the slot beside it holds initials rather than nothing.
    render(<AgentLabel agent="gemini" />);

    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("GM")).toBeInTheDocument();
  });

  it("names an agent it has never heard of rather than dropping it", () => {
    // An unrecognised id still ran the turn. Its id is the truest thing left
    // to call it, and a Task on an unknown agent is not a Task on none.
    render(<AgentLabel agent="weirdtool" />);

    expect(screen.getByText("Weirdtool")).toBeInTheDocument();
  });
});
