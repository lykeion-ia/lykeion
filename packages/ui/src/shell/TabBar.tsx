import type { ComponentType, SVGProps } from "react";
import { taskCode } from "@lykeion/api";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FlaskIcon,
  InboxIcon,
  PlusIcon,
  SparkleIcon,
  WorkflowIcon,
} from "../components/icons";
import { NAV_ALL } from "./nav";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { useRoute } from "../router";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

// Resolve the single active tab (icon + label) from the current route,
// using real Lykeion data instead of mocked lookups.
function useActiveTab(): { icon: IconType; label: string } {
  const route = useRoute();
  const api = useApi();
  const studyId =
    route.name === "study" || route.name === "task" ? route.studyId : null;
  const detail = usePromise(
    () => (studyId ? api.getStudy(studyId) : Promise.resolve(null)),
    [api, studyId],
  );
  if (route.name === "task") {
    const d = detail.data;
    const task = d?.tasks.find((t) => t.id === route.taskId);
    if (d && task)
      return {
        icon: FlaskIcon,
        label: `${taskCode(d.study, task)}: ${task.title}`,
      };
    return { icon: FlaskIcon, label: "Task" };
  }
  if (route.name === "study") {
    if (detail.data) return { icon: FlaskIcon, label: detail.data.study.title };
    return { icon: FlaskIcon, label: "Study" };
  }
  if (route.name === "agent") {
    return { icon: SparkleIcon, label: route.agentId };
  }
  // The id, not the name: the name needs a read, and a pill that filled in
  // afterwards would change under the reader for the length of one fetch.
  if (route.name === "workflow") {
    return { icon: WorkflowIcon, label: route.workflowId };
  }
  const entry = NAV_ALL.find((e) => e.route.name === route.name);
  return entry
    ? { icon: entry.icon, label: entry.label }
    : { icon: InboxIcon, label: "Inbox" };
}

// Browser-style top strip: ‹ › history, the current-view tab pill, and a "+"
// that opens the command palette. Sits above the rounded content pane.
export function TabBar() {
  const { icon: Icon, label } = useActiveTab();

  const iconBtn =
    "grid h-7 w-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface hover:text-fg";

  return (
    <div className="flex h-[42px] shrink-0 items-center gap-1 bg-sidebar px-2.5">
      <button
        type="button"
        aria-label="Back"
        onClick={() => window.history.back()}
        className={iconBtn}
      >
        <ChevronLeftIcon width={16} height={16} />
      </button>
      <button
        type="button"
        aria-label="Forward"
        onClick={() => window.history.forward()}
        className={iconBtn}
      >
        <ChevronRightIcon width={16} height={16} />
      </button>

      <div className="ml-1 flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-1 text-sub text-fg">
        <Icon className="shrink-0 text-accent" width={14} height={14} />
        <span className="max-w-[240px] truncate">{label}</span>
      </div>

      <button
        type="button"
        aria-label="Open menu"
        onClick={() =>
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "k", metaKey: true }),
          )
        }
        className={iconBtn}
      >
        <PlusIcon width={14} height={14} />
      </button>
    </div>
  );
}

export default TabBar;
