import { expect, it } from "vitest";
import { absentApi } from "./absent";
import type { Deps } from "./index";

const absent = absentApi({} as Deps);

it("answers the durable environment setup surface honestly when no family owns it", async () => {
  await expect(
    absent.requestKernelEnvironmentSetup({
      taskId: "t_1",
      machineId: "rt_1",
      environmentName: "analysis",
    }),
  ).rejects.toMatchObject({
    code: "unsupported",
    message: expect.stringMatching(/cannot provision software/i),
  });
  expect(await absent.taskEnvironmentSetups("t_1")).toEqual([]);
  await expect(absent.retryKernelEnvironmentSetup("wait_1")).rejects.toMatchObject({
    code: "unsupported",
    message: expect.stringMatching(/cannot provision software/i),
  });
  await expect(
    absent.answerEnvironmentDefaultSuggestion("suggestion_1", true),
  ).rejects.toMatchObject({
    code: "not-found",
    message: expect.stringMatching(/suggestion_1/),
  });
});
