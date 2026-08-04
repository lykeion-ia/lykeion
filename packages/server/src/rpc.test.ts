import { expect, it, vi } from "vitest";
import { LykeionError, type LykeionApi } from "@lykeion/api";
import { dispatch, rpcMethods } from "./rpc";

function apiWith(overrides: Partial<LykeionApi>): LykeionApi {
  return {
    coreInfo: async () => ({ name: "lykeion-server", version: "0.1.0" }),
    ...overrides,
  } as LykeionApi;
}

it("returns the method's value in a success envelope", async () => {
  const api = apiWith({});
  expect(await dispatch(api, "coreInfo", [])).toEqual({
    ok: true,
    value: { name: "lykeion-server", version: "0.1.0" },
  });
});

it("passes the argument list through positionally", async () => {
  const updateTask = vi.fn(async () => ({ id: "t_1" }));
  const api = apiWith({ updateTask: updateTask as unknown as LykeionApi["updateTask"] });
  await dispatch(api, "updateTask", ["t_1", { status: "in-review" }]);
  expect(updateTask).toHaveBeenCalledWith("t_1", { status: "in-review" });
});

it("turns a contract failure into an error envelope carrying its code", async () => {
  const api = apiWith({
    getTask: async () => {
      throw new LykeionError("not-found", "no such task: t_9");
    },
  });
  expect(await dispatch(api, "getTask", ["t_9"])).toEqual({
    ok: false,
    error: { code: "not-found", message: "no such task: t_9" },
  });
});

it("refuses a name the api does not own, rather than calling it", async () => {
  const api = apiWith({});
  await expect(dispatch(api, "toString", [])).rejects.toThrow(/unknown method/);
  await expect(dispatch(api, "__proto__", [])).rejects.toThrow(/unknown method/);
});

it("refuses arguments that are not a list", async () => {
  const api = apiWith({});
  await expect(
    dispatch(api, "coreInfo", { "0": "sneaky" } as unknown as unknown[]),
  ).rejects.toThrow(/args must be an array/);
});

it("lets an unexpected failure through, rather than dressing it as a contract error", async () => {
  // A crash is not an application outcome. Inventing a code for it tells the
  // client something false about what happened.
  const api = apiWith({
    myWork: async () => {
      throw new TypeError("cannot read properties of undefined");
    },
  });
  await expect(dispatch(api, "myWork", [])).rejects.toThrow(TypeError);
});

it("names every method the api actually implements", () => {
  const api = apiWith({ myWork: async () => [] });
  const names = rpcMethods(api);
  expect(names.has("coreInfo")).toBe(true);
  expect(names.has("myWork")).toBe(true);
  expect(names.has("constructor")).toBe(false);
});
