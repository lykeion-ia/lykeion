import { useEffect, useMemo, useState } from "react";
import type { Study } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { useRoute } from "../router";
import { Rail } from "./Rail";
import { TabBar } from "./TabBar";
import { RailFabs, type RailView } from "./RailFabs";
import { CommandPalette } from "./CommandPalette";
import { buildCommands, type TasksByStudy } from "./commands";
import { StudiesScreen } from "../screens/StudiesScreen";
import { StudyScreen } from "../screens/StudyScreen";
import { TaskScreen } from "../screens/TaskScreen";
import { TasksScreen } from "../screens/TasksScreen";
import { InboxScreen } from "../screens/InboxScreen";
import { MyWorkScreen } from "../screens/MyWorkScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { AgentsScreen } from "../screens/AgentsScreen";
import { AgentDetailScreen } from "../screens/AgentDetailScreen";
import { WorkflowsScreen } from "../screens/WorkflowsScreen";
import { WorkflowDetailScreen } from "../screens/WorkflowDetailScreen";
import { MachinesScreen } from "../screens/MachinesScreen";
import { MyTasksScreen } from "../screens/MyTasksScreen";
import { ResearchGroupsScreen } from "../screens/ResearchGroupsScreen";
import "./shell.css";

/** The app frame: left Rail, top TabBar, rounded content pane, global
 *  command palette. */
export function Shell() {
  const api = useApi();
  const route = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Which element fills the leftmost slot on a three-pane page. Defaults to the
  // page's own rail (Document) — the app Rail is one FAB tap away.
  const [railView, setRailView] = useState<RailView>("context");
  // Whether the mounted screen claims the leftmost slot for its own pane. The
  // Task surface does, and says so; every other screen leaves the app Rail
  // where it is.
  const [screenOwnsRail, setScreenOwnsRail] = useState(false);
  // The DOM node of the Task's left-rail slot; TaskScreen portals its sidebar in.
  const [taskRailEl, setTaskRailEl] = useState<HTMLDivElement | null>(null);
  // Bumped every time the palette opens: the Shell never unmounts, so without
  // this a Study or Task created since it mounted would be missing from the
  // palette.
  const [paletteNonce, setPaletteNonce] = useState(0);
  const indexed = usePromise(async () => {
    const studies = await api.listStudies();
    const details = await Promise.all(studies.map((s) => api.getStudy(s.id)));
    const tasksByStudy: TasksByStudy = {};
    for (const d of details) tasksByStudy[d.study.id] = d.tasks;
    return { studies, tasksByStudy };
  }, [api, paletteNonce]);
  // Hold the last good result so a refresh doesn't blank the palette's
  // per-Study and per-Task commands while it re-reads.
  const [snapshot, setSnapshot] = useState<{
    studies: Study[];
    tasksByStudy: TasksByStudy;
  }>({ studies: [], tasksByStudy: {} });
  useEffect(() => {
    if (indexed.data) setSnapshot(indexed.data);
  }, [indexed.data]);
  const commands = useMemo(
    () => buildCommands(snapshot.studies, snapshot.tasksByStudy),
    [snapshot],
  );
  const openPalette = () => {
    setPaletteNonce((n) => n + 1);
    setPaletteOpen(true);
  };

  // The Task page is the three-pane screen: its own pane in the left slot,
  // the FABs to swap it back for the app Rail. `screenOwnsRail` is the Task
  // surface's own answer, and an unfiled Task says no — it has no Study, so no
  // Task list to put there.
  const isThreePane =
    (route.name === "task" || route.name === "unfiled-task") && screenOwnsRail;
  const showRail = !isThreePane || railView === "nav";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        // Opening refreshes the per-Study routes (see `paletteNonce`).
        if (!paletteOpen) setPaletteNonce((n) => n + 1);
        setPaletteOpen(!paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  // The Task's left-side pane occupies the same slot as the app Rail (they swap
  // via the FABs), so the TabBar keeps its fixed position. TaskScreen portals
  // its sidebar into this slot.
  const showTaskRail = isThreePane && railView === "context";

  return (
    <div className="flex h-screen overflow-hidden bg-sidebar text-fg">
      {showRail && <Rail onOpenPalette={openPalette} />}
      {showTaskRail && (
        <div className="flex w-56 shrink-0" ref={setTaskRailEl} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar />
        <div className="min-h-0 flex-1 p-2 pl-0">
          <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-canvas">
            <ScreenSwitch
              railView={railView}
              onScreenOwnsRail={setScreenOwnsRail}
              railSlot={taskRailEl}
            />
          </div>
        </div>
      </div>
      {isThreePane && <RailFabs view={railView} onChange={setRailView} />}
      {paletteOpen && (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}

function ScreenSwitch({
  railView,
  onScreenOwnsRail,
  railSlot,
}: {
  railView: RailView;
  onScreenOwnsRail: (ownsRail: boolean) => void;
  railSlot: HTMLElement | null;
}) {
  const route = useRoute();
  switch (route.name) {
    case "studies":
      return <StudiesScreen />;
    case "study":
      return <StudyScreen studyId={route.studyId} />;
    case "task":
      return (
        <TaskScreen
          studyId={route.studyId}
          taskId={route.taskId}
          railView={railView}
          onOwnRail={onScreenOwnsRail}
          railSlot={railSlot}
        />
      );
    case "tasks":
      return <TasksScreen />;
    // An unfiled Task opens the same surface a filed one does — it is the same
    // conversation, read by task id. All its address lacks is a Study, and
    // `TaskScreen` leaves the Study-scoped panes off when there is none.
    case "unfiled-task":
      return (
        <TaskScreen
          taskId={route.taskId}
          railView={railView}
          onOwnRail={onScreenOwnsRail}
          railSlot={railSlot}
        />
      );
    case "inbox":
      return <InboxScreen />;
    case "my-work":
      return <MyWorkScreen />;
    case "settings":
      return <SettingsScreen tab={route.tab} />;
    case "agents":
      return <AgentsScreen />;
    case "agent":
      return <AgentDetailScreen agentId={route.agentId} />;
    case "workflows":
      return <WorkflowsScreen />;
    case "workflow":
      return <WorkflowDetailScreen workflowId={route.workflowId} />;
    case "machines":
      return <MachinesScreen />;
    case "my-tasks":
      return <MyTasksScreen />;
    case "research-groups":
      return <ResearchGroupsScreen />;
  }
}
