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
  runtimeId: "rt_1",
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
  it("shows the empty hint when no CLI can run a session", () => {
    render(
      <CliDock
        clis={[
          cli({
            id: "claude",
            name: "Claude Code",
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
        selectedId={cliIdentity({ id: "claude", runtimeId: "rt_1" })}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "GitHub Copilot CLI" }),
    ).toBeEnabled();
  });

  it("keeps two machines' same-named CLI apart rather than colliding on a bare id", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSelect = vi.fn();
    const laptopClaude = cli({ id: "claude", name: "Claude Code", runtimeId: "rt_laptop" });
    const workClaude = cli({ id: "claude", name: "Claude Code", runtimeId: "rt_work" });

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
    // Exactly one of the two is the expanded selected pill…
    expect(document.querySelectorAll(".cli-dock-selected")).toHaveLength(1);
    // …and it names the machine `selectedId` actually pointed at.
    expect(document.querySelector(".cli-dock-machine")).toHaveTextContent(
      "laptop",
    );
    // …while the other renders as its own selectable, un-selected button.
    const btn = screen.getByRole("button", { name: /claude code on workstation/i });
    expect(btn).toBeEnabled();
    btn.click();
    expect(onSelect).toHaveBeenCalledWith(cliIdentity(workClaude));
  });

  it("names the machine on each tile once the CLIs span more than one runtime, and says why an unready one cannot run", () => {
    const laptopClaude = cli({ id: "claude", name: "Claude Code", runtimeId: "rt_laptop" });
    const workCopilot = cli({
      id: "copilot",
      name: "GitHub Copilot CLI",
      runtimeId: "rt_work",
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
          cli({ id: "claude", name: "Claude Code", runtimeId: "rt_laptop" }),
          cli({ id: "copilot", name: "GitHub Copilot CLI", runtimeId: "rt_gpu" }),
        ]}
        selectedId={cliIdentity({ id: "claude", runtimeId: "rt_laptop" })}
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
          cli({ id: "claude", name: "Claude Code", runtimeId: "rt_1" }),
          cli({ id: "copilot", name: "GitHub Copilot CLI", runtimeId: "rt_1" }),
        ]}
        selectedId={cliIdentity({ id: "claude", runtimeId: "rt_1" })}
        onSelect={() => {}}
        machineNames={{ rt_1: "laptop" }}
      />,
    );

    expect(document.querySelector(".cli-dock-machine")).toBeNull();
    expect(
      screen.getByRole("button", { name: "GitHub Copilot CLI" }),
    ).toBeInTheDocument();
  });
});
