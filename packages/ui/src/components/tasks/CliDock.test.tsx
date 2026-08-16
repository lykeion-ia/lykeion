import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentCli } from "@lykeion/api";
import { CliDock, cliIdentity } from "./CliDock";
// The dock's own containment is a stylesheet rule, and the component pulls in
// no CSS of its own — the screens that host it do. Imported here so the rules
// under test are in the document the assertions below read the cascade from.
import "../../screens/task.css";

const cli = (over: Partial<AgentCli>): AgentCli => ({
  id: "x",
  name: "X",
  command: "x",
  version: "",
  available: true,
  machineId: "rt_1",
  sessionReady: true,
  ...over,
});

// Restored here rather than on the last line of the one test that spies on
// `console.error`: an assertion that throws before that line would
// otherwise leave the mock installed for every test declared after it in
// this file, silently swallowing their own React warnings.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("CliDock", () => {
  it("shows the empty hint when no CLIs are available on the machine", () => {
    render(
      <CliDock
        clis={[
          cli({
            id: "claude",
            name: "Claude Code",
            available: false,
            sessionReady: false,
            sessionReadyReason: "no ACP adapter is known for claude yet",
          }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /no agent clis detected/i,
    );
  });

  it("renders a selectable tile for a session-ready CLI", () => {
    render(
      <CliDock
        clis={[
          cli({ id: "claude", name: "Claude Code" }),
          cli({ id: "copilot", name: "GitHub Copilot CLI" }),
        ]}
        selectedId={cliIdentity({ id: "claude", machineId: "rt_1" })}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "GitHub Copilot CLI" }),
    ).toBeEnabled();
  });

  it("renders one tile per CLI id across paired machines", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSelect = vi.fn();
    const laptopClaude = cli({ id: "claude", name: "Claude Code", machineId: "rt_laptop" });
    const workClaude = cli({ id: "claude", name: "Claude Code", machineId: "rt_work" });

    render(
      <CliDock
        clis={[laptopClaude, workClaude]}
        selectedId={cliIdentity(laptopClaude)}
        onSelect={onSelect}
        machineNames={{ rt_laptop: "laptop", rt_work: "workstation" }}
      />,
    );

    // React never warns about duplicate keys when every child's key is
    // actually unique.
    expect(errorSpy).not.toHaveBeenCalled();
    // One CLI kind is one dock entry, even when more than one paired machine
    // reports it.
    expect(document.querySelectorAll(".cli-dock-selected")).toHaveLength(1);
    expect(document.querySelectorAll(".cli-dock-btn")).toHaveLength(0);
    // The first equally healthy candidate remains the representative.
    expect(document.querySelector(".cli-dock-machine")).toHaveTextContent(
      "laptop",
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses the session-ready machine as the single representative", () => {
    const laptopClaude = cli({
      id: "claude",
      name: "Claude Code",
      machineId: "rt_laptop",
      available: true,
      sessionReady: false,
      sessionReadyReason: "adapter is unavailable",
    });
    const workClaude = cli({
      id: "claude",
      name: "Claude Code",
      machineId: "rt_work",
      sessionReady: true,
    });

    render(
      <CliDock
        clis={[laptopClaude, workClaude]}
        selectedId={null}
        onSelect={() => {}}
        machineNames={{ rt_laptop: "laptop", rt_work: "workstation" }}
      />,
    );

    expect(document.querySelectorAll(".cli-dock-selected")).toHaveLength(1);
    expect(document.querySelectorAll(".cli-dock-btn")).toHaveLength(0);
    expect(document.querySelector(".cli-dock-machine")).toHaveTextContent(
      "workstation",
    );
  });

  it("keeps the selected CLI kind when its representative machine changes", () => {
    const laptopClaude = cli({
      id: "claude",
      name: "Claude Code",
      machineId: "rt_laptop",
      sessionReady: false,
    });
    const workClaude = cli({
      id: "claude",
      name: "Claude Code",
      machineId: "rt_work",
      sessionReady: true,
    });
    const codex = cli({ id: "codex", name: "Codex", machineId: "rt_work" });

    render(
      <CliDock
        clis={[codex, laptopClaude, workClaude]}
        selectedId={cliIdentity(laptopClaude)}
        onSelect={() => {}}
        machineNames={{ rt_laptop: "laptop", rt_work: "workstation" }}
      />,
    );

    expect(document.querySelector(".cli-dock-selected")).toHaveTextContent(
      "Claude Code",
    );
  });

  it("names the machine on each tile once the CLIs span more than one machine, and says why an unready one cannot run", () => {
    const laptopClaude = cli({ id: "claude", name: "Claude Code", machineId: "rt_laptop" });
    const workCopilot = cli({
      id: "copilot",
      name: "GitHub Copilot CLI",
      machineId: "rt_work",
      sessionReady: false,
      sessionReadyReason: "no ACP adapter is known for copilot yet",
    });

    render(
      <CliDock
        clis={[laptopClaude, workCopilot]}
        selectedId={cliIdentity(laptopClaude)}
        onSelect={() => {}}
        machineNames={{ rt_laptop: "laptop", rt_work: "workstation" }}
      />,
    );

    const unready = screen.getByRole("button", {
      name: "GitHub Copilot CLI on workstation",
    });
    expect(unready).toBeDisabled();
    expect(unready).toHaveAttribute(
      "title",
      "GitHub Copilot CLI on workstation — no ACP adapter is known for copilot yet",
    );
  });

  /**
   * The row grows by a tile per CLI per machine, and two machines already
   * make it wider than the column it sits in. What can be settled here is
   * which box the overflow belongs to and what that box reserves; where the
   * pixels actually land is not — this environment lays nothing out, so
   * every rect it reports is zero.
   */
  it("hands the overflow to a wrapper that leaves the magnified tile room, rather than to the pill the tiles rise out of", () => {
    render(
      <CliDock
        clis={[
          cli({ id: "claude", name: "Claude Code", machineId: "rt_laptop" }),
          cli({ id: "copilot", name: "GitHub Copilot CLI", machineId: "rt_gpu" }),
        ]}
        selectedId={cliIdentity({ id: "claude", machineId: "rt_laptop" })}
        onSelect={() => {}}
        machineNames={{ rt_laptop: "laptop", rt_gpu: "gpubox" }}
      />,
    );

    const row = document.querySelector(".cli-dock");
    expect(row).not.toBeNull();
    const wrap = row!.parentElement!;
    const wrapStyle = window.getComputedStyle(wrap);

    // The tiles are reachable however long the row gets: what does not fit
    // scrolls instead of rendering across the panel beside it.
    expect(wrapStyle.overflowX).toBe("auto");
    // And the pill itself scrolls nothing — a scroll container there would
    // clip the tile the cursor magnifies, which stands above the pill's own
    // top edge.
    expect(window.getComputedStyle(row!).overflowX).toBe("");
    // The wrapper's clip edge is held off the pill by exactly as much as it
    // gives back, so the row sits where it does with one machine and the
    // raised tile still has somewhere to go.
    const headroom = Number.parseFloat(wrapStyle.paddingTop);
    expect(headroom).toBeGreaterThan(7);
    expect(Number.parseFloat(wrapStyle.marginTop)).toBe(-headroom);
  });

  it("names nothing when every CLI comes from the same machine", () => {
    render(
      <CliDock
        clis={[
          cli({ id: "claude", name: "Claude Code", machineId: "rt_1" }),
          cli({ id: "copilot", name: "GitHub Copilot CLI", machineId: "rt_1" }),
        ]}
        selectedId={cliIdentity({ id: "claude", machineId: "rt_1" })}
        onSelect={() => {}}
        machineNames={{ rt_1: "laptop" }}
      />,
    );

    expect(document.querySelector(".cli-dock-machine")).toBeNull();
    expect(
      screen.getByRole("button", { name: "GitHub Copilot CLI" }),
    ).toBeInTheDocument();
  });

  it("shows nothing at all for an agent the researcher has not installed", () => {
    // The catalogue lists thirteen so phases 2 and 3 have a roadmap. Eleven
    // are not on this machine, and a tile nobody can act on only makes the
    // one they can act on harder to find.
    render(
      <CliDock
        clis={[
          cli({ id: "claude", name: "Claude Code" }),
          cli({ id: "gemini", name: "Gemini", available: false, sessionReady: false }),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByTitle(/Gemini/)).toBeNull();
  });

  it("shows an installed agent that only needs signing in, and says so", () => {
    render(
      <CliDock
        clis={[
          cli({ id: "claude", name: "Claude Code" }),
          cli({
            id: "codex",
            name: "Codex",
            sessionReady: false,
            sessionReadyReason: "Codex is not signed in on this machine — open Lykeion's setup page to sign in",
          }),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTitle(/Codex — Codex is not signed in/)).toBeTruthy();
  });

  it("shows a lone installed-but-unsigned agent with its reason, not the empty state", () => {
    // This is the single most common onboarding case: the CLI is installed but
    // not signed in, and the dock is the fallback sign-in surface for whoever
    // skipped the pairing page or whose token lapsed months later.
    render(
      <CliDock
        clis={[
          cli({
            id: "codex",
            name: "Codex",
            available: true,
            sessionReady: false,
            sessionReadyReason: "Codex is not signed in on this machine — open Lykeion's setup page to sign in",
          }),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    // The agent's button should appear with its reason in the title.
    expect(screen.getByTitle(/Codex — Codex is not signed in/)).toBeTruthy();
    // The empty state should not appear.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not hide an agent ready across paired machines because filtering happens before rank", () => {
    // `available` and `sessionReady` are probed as two independent questions.
    // `{ available: false, sessionReady: true }` is reachable: the ACP adapter
    // is installed but the CLI binary is not on PATH. Machine B scores rank 2
    // (sessionReady) vs machine A's rank 1 (available), so B wins the
    // representative slot. Filtering before rank keeps both machines in
    // the contest, so the session-ready one is chosen.
    render(
      <CliDock
        clis={[
          cli({
            id: "claude",
            name: "Claude Code",
            machineId: "rt_a",
            available: true,
            sessionReady: false,
          }),
          cli({
            id: "claude",
            name: "Claude Code",
            machineId: "rt_b",
            available: false,
            sessionReady: true,
          }),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
        machineNames={{ rt_a: "laptop", rt_b: "workstation" }}
      />,
    );
    // The session-ready machine's tile should appear, even though its CLI
    // binary is not on PATH.
    expect(document.querySelector(".cli-dock-machine")).toHaveTextContent("workstation");
  });
});
