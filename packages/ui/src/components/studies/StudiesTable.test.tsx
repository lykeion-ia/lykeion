import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type Study, type Task } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { RouterProvider } from "../../router";
import { StudiesTable, type StudiesTableProps } from "./StudiesTable";

afterEach(cleanup);

const study: Study = {
  id: "s1",
  key: "AAA",
  title: "Alpha study",
  createdBy: "u_you",
  createdTs: 1,
  updatedTs: 2,
};
const tasks: Task[] = [
  {
    id: "t1",
    number: 1,
    studyId: "s1",
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
    studyId: "s1",
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

it("shows a study row with derived status and progress", async () => {
  render(
    <ApiProvider api={createInMemoryApi()}>
      <RouterProvider>
        <StudiesTable studies={[study]} tasksByStudy={{ s1: tasks }} />
      </RouterProvider>
    </ApiProvider>,
  );
  expect(await screen.findByText("Alpha study")).toBeInTheDocument();
  expect(screen.getByText("In Progress")).toBeInTheDocument();
  expect(screen.getByText("1/2")).toBeInTheDocument();
});

describe("archive actions", () => {
  const live: Study = {
    id: "s_live",
    key: "LIV",
    title: "Live study",
    createdBy: "u_you",
    createdTs: 2,
    updatedTs: 2,
  };
  const archived: Study = {
    id: "s_arch",
    key: "ARC",
    title: "Archived study",
    createdBy: "u_you",
    createdTs: 1,
    updatedTs: 1,
    archivedTs: 1,
  };

  function renderTable(props: Partial<StudiesTableProps>) {
    return render(
      <ApiProvider api={createInMemoryApi()}>
        <RouterProvider>
          <StudiesTable studies={[live, archived]} tasksByStudy={{}} {...props} />
        </RouterProvider>
      </ApiProvider>,
    );
  }

  it("offers Archive on a live Study and Restore on an archived one", async () => {
    const onArchive = vi.fn();
    const onRestore = vi.fn();
    renderTable({ onArchive, onRestore });
    expect(
      await screen.findByRole("button", { name: "Archive Live study" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restore Archived study" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archive Archived study" }),
    ).toBeNull();
  });

  it("marks an archived row so the two are distinguishable", async () => {
    renderTable({ onArchive: vi.fn(), onRestore: vi.fn() });
    const archivedRow = (await screen.findByText("Archived study")).closest(
      "a",
    ) as HTMLElement;
    const liveRow = screen.getByText("Live study").closest(
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
      await screen.findByRole("button", { name: "Archive Live study" }),
    );
    expect(onArchive).toHaveBeenCalledWith(live);
  });

  it("calls the handler for the clicked row even when it isn't the first one", async () => {
    const secondLive: Study = {
      id: "s_live2",
      key: "LV2",
      title: "Second live study",
      createdBy: "u_you",
      createdTs: 3,
      updatedTs: 3,
    };
    const onArchive = vi.fn();
    render(
      <ApiProvider api={createInMemoryApi()}>
        <RouterProvider>
          <StudiesTable
            studies={[live, secondLive, archived]}
            tasksByStudy={{}}
            onArchive={onArchive}
            onRestore={vi.fn()}
          />
        </RouterProvider>
      </ApiProvider>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Archive Second live study" }),
    );
    expect(onArchive).toHaveBeenCalledWith(secondLive);
    expect(onArchive).not.toHaveBeenCalledWith(live);
  });

  it("hides both actions when neither handler is given", async () => {
    render(
      <ApiProvider api={createInMemoryApi()}>
        <RouterProvider>
          <StudiesTable studies={[live]} tasksByStudy={{}} />
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
  const plain: Study = {
    id: "s_plain",
    key: "PLN",
    title: "Plain study",
    createdBy: "u_you",
    createdTs: 3,
    updatedTs: 3,
  };
  const pinned: Study = {
    id: "s_pin",
    key: "PIN",
    title: "Pinned study",
    createdBy: "u_you",
    createdTs: 1,
    updatedTs: 1,
    pinned: true,
  };

  function renderTable(studies: Study[]) {
    return render(
      <ApiProvider api={createInMemoryApi()}>
        <RouterProvider>
          <StudiesTable studies={studies} tasksByStudy={{}} />
        </RouterProvider>
      </ApiProvider>,
    );
  }

  it("labels no group at all while nothing is pinned", async () => {
    // A resting list must look exactly as it did before pinning existed —
    // an eyebrow over a single ungrouped run of rows is noise.
    renderTable([plain]);
    expect(await screen.findByText("Plain study")).toBeInTheDocument();
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(screen.queryByText("Studies")).toBeNull();
  });

  it("lifts a pinned Study into its own labelled group above the rest", async () => {
    renderTable([plain, pinned]);
    expect(await screen.findByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("Studies")).toBeInTheDocument();

    // Reading order, not merely membership: the pinned row has to come first
    // even though the list handed it over second.
    const titles = screen
      .getAllByText(/study$/)
      .map((n) => n.textContent);
    expect(titles).toEqual(["Pinned study", "Plain study"]);
  });

  it("shows a pinned Study once, not in both groups", async () => {
    renderTable([plain, pinned]);
    expect(await screen.findAllByText("Pinned study")).toHaveLength(1);
  });
});
