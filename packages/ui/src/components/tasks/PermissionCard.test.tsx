import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

/**
 * Installing software: the one card whose consequence lands on machines
 * other than this one. The environment is lab-wide and each colleague's
 * laptop builds it, so what is being approved is not a call — it is packages
 * on everybody's disk.
 */
describe("PermissionCard — an environment", () => {
  it("names the environment and every package before anything installs", () => {
    render(
      <PermissionCard
        request={{
          id: "p1",
          tool: "manage_environments",
          access: {
            kind: "environment",
            target: { name: "crispr", packages: ["scanpy", "anndata"] },
          },
        }}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.getByText("Create environment crispr?")).toBeInTheDocument();
    expect(screen.getByText(/scanpy/)).toBeInTheDocument();
    expect(screen.getByText(/anndata/)).toBeInTheDocument();
  });

  it("offers no standing grant to install software", async () => {
    const user = userEvent.setup();
    render(
      <PermissionCard
        request={{
          id: "p1",
          tool: "manage_packages",
          access: {
            kind: "environment",
            target: { name: "python", packages: ["scanpy"] },
          },
        }}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Choose approval scope" }),
    );
    // Global here would be a standing grant to run strangers' build scripts
    // on colleagues' machines, permanently, without being asked again.
    expect(screen.queryByText("Global")).not.toBeInTheDocument();
    expect(screen.queryByText("This Study")).not.toBeInTheDocument();
    expect(screen.getByText("Once")).toBeInTheDocument();
    expect(screen.getByText("This conversation")).toBeInTheDocument();
  });

  it("starts on Once, not on this conversation", async () => {
    // The button's label renders FROM the selected scope, so the narrower
    // default is readable before the menu is ever opened — and a click
    // straight through grants the narrow thing rather than the wide one.
    const user = userEvent.setup();
    const onAllow = vi.fn();
    render(
      <PermissionCard
        request={{
          id: "p1",
          tool: "manage_environments",
          access: {
            kind: "environment",
            target: { name: "crispr", packages: ["scanpy"] },
          },
        }}
        onAllow={onAllow}
        onDeny={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onAllow).toHaveBeenCalledWith("once");
  });

  it("expands the package list on first paint, labelled for what it is", () => {
    // The same rule a shell command's code block follows: what is being
    // approved is visible with zero clicks, because approving what you
    // cannot see is not consent. The title names one or two packages at
    // most; what actually lands on every machine in the lab is the list.
    render(
      <PermissionCard
        request={{
          id: "p1",
          tool: "manage_environments",
          access: {
            kind: "environment",
            target: { name: "crispr", packages: ["scanpy", "anndata"] },
          },
        }}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    const disclosure = screen.getByText("Packages").closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure).toHaveAttribute("open");
  });

  it("says what an environment with no packages is, rather than showing nothing", () => {
    // `[]` is legal and means an environment holding only its interpreter.
    // Rendered as the empty string it would be a consent card with a blank
    // where the thing being approved goes.
    render(
      <PermissionCard
        request={{
          id: "p1",
          tool: "manage_environments",
          access: { kind: "environment", target: { name: "bare", packages: [] } },
        }}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(
      screen.getByText("bare — no packages, the interpreter only"),
    ).toBeInTheDocument();
  });

  it("says what allowing for this conversation actually covers", () => {
    // The grant behind it is kept by the environment's NAME, so it covers any
    // later change to that environment for the rest of the conversation. That
    // is the design — keyed by the package list the scope would cover nothing
    // and ask every time — but a standing grant the researcher did not know
    // they were giving is not, so the row has to say it.
    render(
      <PermissionCard
        request={{
          id: "p1",
          tool: "manage_packages",
          access: {
            kind: "environment",
            target: { name: "python", packages: ["scanpy"] },
          },
        }}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose approval scope" }));
    expect(
      screen.getByText("Any packages for this environment, until this chat ends"),
    ).toBeInTheDocument();
    // And the generic wording is gone rather than sitting beside it.
    expect(screen.queryByText("Until this chat ends")).not.toBeInTheDocument();
  });

  it("does not pass off the daemon's own description as the agent's reason", () => {
    // `manage_environments` publishes no "why" argument, so nothing an agent
    // said can arrive in `detail`. What is there is the one-line name this
    // decision is recorded under, and rendering it under "Agent-supplied
    // reason." would attribute a description to the agent as a justification
    // — as well as saying for a third time what the question and the package
    // list already say.
    render(
      <PermissionCard
        request={{
          id: "p1",
          tool: "manage_environments",
          detail: "Create the environment crispr with scanpy",
          access: {
            kind: "environment",
            target: { name: "crispr", packages: ["scanpy"] },
          },
        }}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.queryByText("Agent-supplied reason.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Create the environment crispr with scanpy"),
    ).not.toBeInTheDocument();
    // The question and the packages are still there — this drops a third
    // copy, not the card's content.
    expect(screen.getByText("Create environment crispr?")).toBeInTheDocument();
    expect(screen.getByText(/scanpy/)).toBeInTheDocument();
  });

  it("asks the other question when it is the packages tool asking", () => {
    // One kind, two tools, two different questions. Declaring an environment
    // and adding to one that already exists are the same fact being
    // consented to and not the same sentence, and a card that asked one in
    // the other's words would have a researcher approve the wrong thing.
    render(
      <PermissionCard
        request={{
          id: "p1",
          tool: "manage_packages",
          access: {
            kind: "environment",
            target: { name: "python", packages: ["scanpy", "anndata"] },
          },
        }}
        onAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(
      screen.getByText("Add scanpy and anndata to python?"),
    ).toBeInTheDocument();
  });
});
