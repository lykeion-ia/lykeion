import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type Research, type Task } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { RouterProvider } from "../../router";
import { ResearchesTable, type ResearchesTableProps } from "./ResearchesTable";

afterEach(cleanup);

const research: Research = {
  id: "s1",
  key: "AAA",
  title: "Alpha research",
  createdBy: "u_you",
  createdTs: 1,
  updatedTs: 2,
};
const tasks: Task[] = [
  {
    id: "t1",
    number: 1,
    researchId: "s1",
    stage: "methods",
    title: "T1",
    status: "in-progress",
    priority: "high",
    assignees: [{ kind: "user", userId: "u_you" }],
    createdBy: "u_you",
    runCount: 0,
    createdTs: 1,
    updatedTs: 2,
  },
  {
    id: "t2",
    number: 2,
    researchId: "s1",
    stage: "results",
    title: "T2",
    status: "done",
    priority: "low",
    assignees: [{ kind: "user", userId: "u_you" }],
    createdBy: "u_you",
    runCount: 0,
    createdTs: 1,
    updatedTs: 2,
  },
];

it("shows a research row with derived status and progress", async () => {
  render(
    <ApiProvider api={createInMemoryApi()}>
      <RouterProvider>
        <ResearchesTable researches={[research]} tasksByResearch={{ s1: tasks }} />
      </RouterProvider>
    </ApiProvider>,
  );
  expect(await screen.findByText("Alpha research")).toBeInTheDocument();
  expect(screen.getByText("In Progress")).toBeInTheDocument();
  expect(screen.getByText("1/2")).toBeInTheDocument();
});

describe("archive actions", () => {
  const live: Research = {
    id: "s_live",
    key: "LIV",
    title: "Live research",
    createdBy: "u_you",
    createdTs: 2,
    updatedTs: 2,
  };
  const archived: Research = {
    id: "s_arch",
    key: "ARC",
    title: "Archived research",
    createdBy: "u_you",
    createdTs: 1,
    updatedTs: 1,
    archivedTs: 1,
  };

  function renderTable(props: Partial<ResearchesTableProps>) {
    return render(
      <ApiProvider api={createInMemoryApi()}>
        <RouterProvider>
          <ResearchesTable researches={[live, archived]} tasksByResearch={{}} {...props} />
        </RouterProvider>
      </ApiProvider>,
    );
  }

  it("offers Archive on a live Research and Restore on an archived one", async () => {
    const onArchive = vi.fn();
    const onRestore = vi.fn();
    renderTable({ onArchive, onRestore });
    expect(
      await screen.findByRole("button", { name: "Archive Live research" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restore Archived research" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archive Archived research" }),
    ).toBeNull();
  });

  it("marks an archived row so the two are distinguishable", async () => {
    renderTable({ onArchive: vi.fn(), onRestore: vi.fn() });
    const archivedRow = (await screen.findByText("Archived research")).closest(
      "a",
    ) as HTMLElement;
    const liveRow = screen.getByText("Live research").closest(
      "a",
    ) as HTMLElement;
    expect(archivedRow).not.toBeNull();
    expect(liveRow).not.toBeNull();
    // Scoped to each row: the marker must sit on the archived row and only
    // the archived row, not merely exist somewhere in the document.
    expect(within(archivedRow).getByText("Archived")).toBeInTheDocument();
    expect(within(liveRow).queryByText("Archived")).toBeNull();
  });

  it("calls the handler for the row it was clicked on", async () => {
    const onArchive = vi.fn();
    renderTable({ onArchive, onRestore: vi.fn() });
    await userEvent.click(
      await screen.findByRole("button", { name: "Archive Live research" }),
    );
    expect(onArchive).toHaveBeenCalledWith(live);
  });

  it("calls the handler for the clicked row even when it isn't the first one", async () => {
    const secondLive: Research = {
      id: "s_live2",
      key: "LV2",
      title: "Second live research",
      createdBy: "u_you",
      createdTs: 3,
      updatedTs: 3,
    };
    const onArchive = vi.fn();
    render(
      <ApiProvider api={createInMemoryApi()}>
        <RouterProvider>
          <ResearchesTable
            researches={[live, secondLive, archived]}
            tasksByResearch={{}}
            onArchive={onArchive}
            onRestore={vi.fn()}
          />
        </RouterProvider>
      </ApiProvider>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Archive Second live research" }),
    );
    expect(onArchive).toHaveBeenCalledWith(secondLive);
    expect(onArchive).not.toHaveBeenCalledWith(live);
  });

  it("hides both actions when neither handler is given", async () => {
    render(
      <ApiProvider api={createInMemoryApi()}>
        <RouterProvider>
          <ResearchesTable researches={[live]} tasksByResearch={{}} />
        </RouterProvider>
      </ApiProvider>,
    );
    expect(await screen.findByText(live.title)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /archive/i }),
    ).toBeNull();
  });
});

describe("the pinned group", () => {
  const plain: Research = {
    id: "s_plain",
    key: "PLN",
    title: "Plain research",
    createdBy: "u_you",
    createdTs: 3,
    updatedTs: 3,
  };
  const pinned: Research = {
    id: "s_pin",
    key: "PIN",
    title: "Pinned research",
    createdBy: "u_you",
    createdTs: 1,
    updatedTs: 1,
    pinned: true,
  };

  function renderTable(researches: Research[]) {
    return render(
      <ApiProvider api={createInMemoryApi()}>
        <RouterProvider>
          <ResearchesTable researches={researches} tasksByResearch={{}} />
        </RouterProvider>
      </ApiProvider>,
    );
  }

  it("labels no group at all while nothing is pinned", async () => {
    // A resting list must look exactly as it did before pinning existed —
    // an eyebrow over a single ungrouped run of rows is noise.
    renderTable([plain]);
    expect(await screen.findByText("Plain research")).toBeInTheDocument();
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(screen.queryByText("Researches")).toBeNull();
  });

  it("lifts a pinned Research into its own labelled group above the rest", async () => {
    renderTable([plain, pinned]);
    expect(await screen.findByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("Researches")).toBeInTheDocument();

    // Reading order, not merely membership: the pinned row has to come first
    // even though the list handed it over second.
    const titles = screen
      .getAllByText(/research$/)
      .map((n) => n.textContent);
    expect(titles).toEqual(["Pinned research", "Plain research"]);
  });

  it("shows a pinned Research once, not in both groups", async () => {
    renderTable([plain, pinned]);
    expect(await screen.findAllByText("Pinned research")).toHaveLength(1);
  });
});
