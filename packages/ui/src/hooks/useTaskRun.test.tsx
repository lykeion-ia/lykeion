import { renderHook, waitFor } from "@testing-library/react";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../api/ApiContext";
import { useTaskRun } from "./useTaskRun";

const wrap = (api: ReturnType<typeof createInMemoryApi>) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <ApiProvider api={api}>{children}</ApiProvider>;
  };

describe("a Task's run wiring", () => {
  it("starts with an empty transcript for a Task nobody has spoken in", async () => {
    const api = createInMemoryApi(emptySeed());
    const study = await api.createStudy({ title: "Compression", key: "CMP" });
    const task = await api.createTask({
      studyId: study.id,
      stage: "methods",
      title: "Nothing said here yet",
    });
    const { result } = renderHook(() => useTaskRun(study.id, task.id), {
      wrapper: wrap(api),
    });
    await waitFor(() => expect(result.current.history).toEqual([]));
    expect(result.current.viewTurns).toEqual([]);
  });

  it("loads the persisted turns of a Task that has them", async () => {
    const api = createInMemoryApi();
    const { result } = renderHook(() => useTaskRun("s_cmp", "t_3"), {
      wrapper: wrap(api),
    });
    await waitFor(() => expect(result.current.history).toHaveLength(2));
    expect(result.current.history[0].prompt).toContain("Motion-correct");
  });
});
