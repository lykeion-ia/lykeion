import { expect, it } from "vitest";
import { createInMemoryApi, emptySeed } from "./index";

it("records setup intent without pretending the browser built software", async () => {
  const api = createInMemoryApi(emptySeed());
  const research = await api.createResearch({ key: "META", title: "Meta-analysis" });
  const task = await api.createTask({
    researchId: research.id,
    title: "Fit the model",
    stage: "methods",
  });

  await expect(api.requestKernelEnvironmentSetup({
    taskId: task.id,
    machineId: "rt_local",
    environmentName: "r",
  })).rejects.toThrow(/cannot provision software/i);
  expect(await api.taskEnvironmentSetups(task.id)).toEqual([]);
});

it("refuses setup retries without pretending the browser provisioned software", async () => {
  const api = createInMemoryApi(emptySeed());

  await expect(api.retryKernelEnvironmentSetup("wait_1")).rejects.toMatchObject({
    code: "unsupported",
    message: expect.stringMatching(/cannot provision software/i),
  });
});

it("reports an unknown environment default suggestion as not found", async () => {
  const api = createInMemoryApi(emptySeed());

  await expect(api.answerEnvironmentDefaultSuggestion("suggestion_1", true)).rejects.toMatchObject({
    code: "not-found",
  });
});
