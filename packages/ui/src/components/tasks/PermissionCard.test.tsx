import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PermissionRequest } from "@lykeion/api";
import { PermissionCard } from "./PermissionCard";

const REQUEST: PermissionRequest = {
  id: "perm-1",
  access: { kind: "execute", target: "rm -rf build" },
  tool: "Bash",
  // A real agent-supplied REASON, carried on the card —
  // not a restatement of the card's own title.
  detail: "Clear the stale build output before rebuilding.",
};

describe("PermissionCard", () => {
  it("shows the requested command on first render, with no interaction", () => {
    render(
      <PermissionCard request={REQUEST} onAllow={() => {}} onDeny={() => {}} />,
    );
    // The headline names what is about to happen, as a question.
    expect(screen.getByText("Run a shell command?")).toBeInTheDocument();
    // The agent's reason, attributed to the agent rather than asserted by us.
    expect(
      screen.getByText("Clear the stale build output before rebuilding."),
    ).toBeInTheDocument();
    expect(screen.getByText("Agent-supplied reason.")).toBeInTheDocument();
    // The command itself, in a code presentation — visible with zero clicks.
    expect(screen.getByText("rm -rf build")).toBeInTheDocument();
  });

  it("places the card in its batch when the turn raised more than one gate", () => {
    render(
      <PermissionCard
        request={REQUEST}
        queue={{ position: 2, total: 4 }}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByTestId("perm-queue")).toHaveTextContent("2 of 4");
    // A bare pair of numbers says nothing to a screen reader, so the chip
    // carries the sentence alongside it.
    expect(
      screen.getByText("Decision 2 of 4 this turn is asking for."),
    ).toBeInTheDocument();
  });

  it("says nothing about a batch when this is the only gate open", () => {
    render(
      <PermissionCard request={REQUEST} onAllow={() => {}} onDeny={() => {}} />,
    );
    // "1 of 1" is a count of nothing, and a card that shows it invites the
    // researcher to look for a batch that does not exist.
    expect(screen.queryByTestId("perm-queue")).not.toBeInTheDocument();
  });

  it("Allow, clicked with no menu interaction, calls onAllow('conversation')", async () => {
    const user = userEvent.setup();
    const onAllow = vi.fn();
    render(
      <PermissionCard request={REQUEST} onAllow={onAllow} onDeny={() => {}} />,
    );

    // The default scope is spelled out on the button itself.
    const allow = screen.getByRole("button", {
      name: "Allow for this conversation",
    });
    await user.click(allow);
    expect(onAllow).toHaveBeenCalledWith("conversation");
  });

  it("opening the menu and choosing Global does not grant; a subsequent Allow click does", async () => {
    const user = userEvent.setup();
    const onAllow = vi.fn();
    render(
      <PermissionCard request={REQUEST} onAllow={onAllow} onDeny={() => {}} />,
    );

    await user.click(
      screen.getByRole("button", { name: "Choose approval scope" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Global" }));

    // Selecting the scope sets it and closes the menu — it does not grant.
    expect(onAllow).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();

    // The button label updates to reflect the newly-selected scope…
    const allow = screen.getByRole("button", { name: "Allow globally" });
    // …and only a deliberate click on it grants, at that scope.
    await user.click(allow);
    expect(onAllow).toHaveBeenCalledWith("global");
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it("Deny calls onDeny", async () => {
    const user = userEvent.setup();
    const onDeny = vi.fn();
    render(
      <PermissionCard request={REQUEST} onAllow={() => {}} onDeny={onDeny} />,
    );
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("each menu item renders its description", async () => {
    const user = userEvent.setup();
    render(
      <PermissionCard request={REQUEST} onAllow={() => {}} onDeny={() => {}} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Choose approval scope" }),
    );

    expect(screen.getByText("This call only")).toBeInTheDocument();
    expect(screen.getByText("Until this chat ends")).toBeInTheDocument();
    expect(screen.getByText("Remembered for this Study")).toBeInTheDocument();
    expect(
      screen.getByText("Remembered across all projects"),
    ).toBeInTheDocument();
  });

  it("the current scope carries aria-checked", async () => {
    const user = userEvent.setup();
    render(
      <PermissionCard request={REQUEST} onAllow={() => {}} onDeny={() => {}} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Choose approval scope" }),
    );

    // Default scope: "This conversation" is checked, the others are not.
    expect(
      screen.getByRole("menuitemradio", { name: "This conversation" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Once" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // Re-opening after picking Global carries the check onto Global instead.
    await user.click(screen.getByRole("menuitemradio", { name: "Global" }));
    await user.click(
      screen.getByRole("button", { name: "Choose approval scope" }),
    );
    expect(
      screen.getByRole("menuitemradio", { name: "Global" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemradio", { name: "This conversation" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("the trigger has aria-haspopup/aria-expanded; Escape closes and returns focus", async () => {
    const user = userEvent.setup();
    render(
      <PermissionCard request={REQUEST} onAllow={() => {}} onDeny={() => {}} />,
    );

    const trigger = screen.getByRole("button", {
      name: "Choose approval scope",
    });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Move focus off the trigger and INTO the menu before dismissing, so
    // the assertion below proves Escape moves focus back rather than
    // merely finding it already there.
    await user.tab();
    expect(trigger).not.toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("renders no lang on the code block for a non-execute access kind", () => {
    const readRequest: PermissionRequest = {
      id: "perm-2",
      access: { kind: "read-path", target: "/data/traces.csv" },
      tool: "Read",
    };
    const { container } = render(
      <PermissionCard
        request={readRequest}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.querySelector(".code-block-lang")).toBeNull();
    expect(screen.getByText("/data/traces.csv")).toBeInTheDocument();
  });
});

/**
 * Network access: the card is titled by the HOST it wants to reach, carries
 * the agent's own reason for wanting it, and keeps the raw form behind a
 * `Details` disclosure. Per-host, exact-match, deny-by-default is already the
 * engine's model — this is the surface half.
 */
describe("PermissionCard — network access", () => {
  const NETWORK: PermissionRequest = {
    id: "perm-net",
    access: { kind: "network", target: "www.addgene.org" },
    tool: "Bash",
    detail:
      "Download the Broad GPP Brunello genome-wide CRISPR knockout library contents file.",
  };

  it("titles the card by the host it wants to connect to", () => {
    render(
      <PermissionCard request={NETWORK} onAllow={() => {}} onDeny={() => {}} />,
    );
    expect(
      screen.getByText("Connect to www.addgene.org?"),
    ).toBeInTheDocument();
  });

  it("shows the agent's reason, attributed to the agent", () => {
    render(
      <PermissionCard request={NETWORK} onAllow={() => {}} onDeny={() => {}} />,
    );
    expect(
      screen.getByText(
        "Download the Broad GPP Brunello genome-wide CRISPR knockout library contents file.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Agent-supplied reason.")).toBeInTheDocument();
  });

  it("folds the raw target behind Details, since the title already names it", () => {
    render(
      <PermissionCard request={NETWORK} onAllow={() => {}} onDeny={() => {}} />,
    );
    const disclosure = screen.getByText("Details").closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
  });

  it("keeps the scoped Allow control — a host grant is still scoped", async () => {
    const user = userEvent.setup();
    const onAllow = vi.fn();
    render(
      <PermissionCard request={NETWORK} onAllow={onAllow} onDeny={() => {}} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Allow for this conversation" }),
    );
    expect(onAllow).toHaveBeenCalledWith("conversation");
  });

  it("expands a shell command but not a host — consent needs the command visible", () => {
    const { unmount } = render(
      <PermissionCard request={NETWORK} onAllow={() => {}} onDeny={() => {}} />,
    );
    expect(screen.getByText("Details").closest("details")).not.toHaveAttribute(
      "open",
    );
    unmount();
    render(
      <PermissionCard request={REQUEST} onAllow={() => {}} onDeny={() => {}} />,
    );
    expect(screen.getByText("Code").closest("details")).toHaveAttribute("open");
  });
});
