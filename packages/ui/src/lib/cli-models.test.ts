import { describe, expect, it } from "vitest";
import { modelLabel, modelsForCli } from "./cli-models";

describe("cli-models", () => {
  it("lists real Claude models for the claude CLI", () => {
    const models = modelsForCli("claude");
    expect(models.map((m) => m.value)).toEqual(["opus", "sonnet", "haiku"]);
    expect(models[0]).toEqual({
      value: "opus",
      label: "Opus 5",
      desc: "For complex tasks",
    });
  });

  it("returns no static catalog for ACP CLIs or an unknown id", () => {
    expect(modelsForCli("copilot")).toEqual([]);
    expect(modelsForCli("cursor")).toEqual([]);
    expect(modelsForCli("nope")).toEqual([]);
    expect(modelsForCli(null)).toEqual([]);
  });

  it("resolves a selected value to its label, else null", () => {
    expect(modelLabel("claude", "sonnet")).toBe("Sonnet 5");
    expect(modelLabel("claude", null)).toBeNull();
    expect(modelLabel("claude", "ghost")).toBeNull();
    expect(modelLabel("copilot", "opus")).toBeNull();
  });
});
