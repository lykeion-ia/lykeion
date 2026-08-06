import { expect, it } from "vitest";
import { confirmationOf, ordinaryWorkingMode, readAdvertised } from "./agent-options";

it("reads a session's config options into one shape", () => {
  const advertised = readAdvertised({
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5",
        options: [
          { id: "gpt-5", name: "GPT-5", description: "the default" },
          { id: "gpt-5-mini", name: "GPT-5 mini" },
        ],
      },
    ],
  });
  expect(advertised.setter).toBe("config");
  expect(advertised.options).toEqual([
    {
      id: "model",
      category: "model",
      currentValue: "gpt-5",
      choices: [
        { value: "gpt-5", label: "GPT-5", description: "the default" },
        { value: "gpt-5-mini", label: "GPT-5 mini" },
      ],
    },
  ]);
});

it("reads an advertised model list as one option of the same shape", () => {
  const advertised = readAdvertised({
    models: {
      currentModelId: "sonnet",
      availableModels: [
        { modelId: "opus", name: "Opus", description: "for complex work" },
        { modelId: "sonnet", name: "Sonnet" },
      ],
    },
  });
  expect(advertised.setter).toBe("model");
  expect(advertised.options).toEqual([
    {
      id: "model",
      category: "model",
      currentValue: "sonnet",
      choices: [
        { value: "opus", label: "Opus", description: "for complex work" },
        { value: "sonnet", label: "Sonnet" },
      ],
    },
  ]);
});

it("prefers config options where an agent advertises both", () => {
  const advertised = readAdvertised({
    configOptions: [
      { id: "model", category: "model", options: [{ id: "a", name: "A" }] },
    ],
    models: { currentModelId: "b", availableModels: [{ modelId: "b", name: "B" }] },
  });
  expect(advertised.setter).toBe("config");
  expect(advertised.options.map((o) => o.choices.map((c) => c.value))).toEqual([["a"]]);
});

it("reads modes into the same shape, so nothing downstream has a second one", () => {
  const advertised = readAdvertised({
    modes: {
      currentModeId: "agent",
      availableModes: [
        { id: "read-only", name: "Read only" },
        { id: "agent", name: "Agent" },
        { id: "agent-full-access", name: "Full access" },
      ],
    },
  });
  expect(advertised.options).toEqual([
    {
      id: "mode",
      category: "mode",
      currentValue: "agent",
      choices: [
        { value: "read-only", label: "Read only" },
        { value: "agent", label: "Agent" },
        { value: "agent-full-access", label: "Full access" },
      ],
    },
  ]);
});

it("says an agent advertised nothing, which is not the same as never being asked", () => {
  const advertised = readAdvertised({ sessionId: "s" });
  expect(advertised.options).toEqual([]);
  expect(advertised.setter).toBe("none");
});

it("takes the agent's ordinary working mode and never its full-access one", () => {
  const modes = [
    { value: "read-only", label: "Read only" },
    { value: "agent", label: "Agent" },
    { value: "agent-full-access", label: "Full access" },
  ];
  expect(ordinaryWorkingMode({ id: "mode", category: "mode", choices: modes })).toBe("agent");
});

it("leaves a mode alone when none of what is offered is an ordinary working one", () => {
  expect(
    ordinaryWorkingMode({
      id: "mode",
      category: "mode",
      choices: [{ value: "yolo", label: "Yolo" }],
    }),
  ).toBeUndefined();
});

it("never selects a mode that is already the current one", () => {
  expect(
    ordinaryWorkingMode({
      id: "mode",
      category: "mode",
      currentValue: "default",
      choices: [
        { value: "default", label: "Default" },
        { value: "bypassPermissions", label: "Bypass permissions" },
      ],
    }),
  ).toBeUndefined();
});

it("confirms a set only when the agent echoed the new value back", () => {
  const echoed = {
    configOptions: [
      { id: "model", category: "model", currentValue: "opus", options: [{ id: "opus", name: "Opus" }] },
    ],
  };
  expect(confirmationOf(echoed, "model", "opus")).toEqual({ value: "opus", confirmed: true });
});

it("does not confirm a set the agent answered with nothing", () => {
  expect(confirmationOf({}, "model", "opus")).toEqual({ value: "opus", confirmed: false });
});

it("reads a rejected set off the value that came back, not the one asked for", () => {
  const echoed = {
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "sonnet",
        options: [{ id: "sonnet", name: "Sonnet" }],
      },
    ],
  };
  expect(confirmationOf(echoed, "model", "opus")).toEqual({ value: "sonnet", confirmed: false });
});
