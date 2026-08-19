import type { Research, Task } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { useListNav } from "../hooks/useListNav";
import { useRouter } from "../router";
import { TaskRow } from "../components/TaskRow";
import "./screens.css";

interface Group {
  research: Research;
  tasks: Task[];
}

/** Everything assigned to me that isn't Done, grouped by research. */
export function MyWorkScreen() {
  const api = useApi();
  const { navigate } = useRouter();

  const work = usePromise<Group[]>(async () => {
    // Archived researches included: archiving tidies the Researches list, it does
    // not finish the work, and a group whose research is missing here would take
    // its assigned tasks off the screen with it.
    const [tasks, researches] = await Promise.all([
      api.myWork(),
      api.listResearches({ includeArchived: true }),
    ]);
    return researches
      .map((research) => ({
        research,
        tasks: tasks.filter((t) => t.researchId === research.id),
      }))
      .filter((group) => group.tasks.length > 0);
  }, [api]);

  const groups = work.data ?? [];
  const ordered = groups.flatMap((group) =>
    group.tasks.map((task) => ({ research: group.research, task })),
  );

  const { index, select, setRef } = useListNav(ordered.length, (i) => {
    const entry = ordered[i];
    if (entry)
      navigate({
        name: "task",
        researchId: entry.research.id,
        taskId: entry.task.id,
      });
  });

  let cursor = 0;
  return (
    <div className="screen">
      <header className="screen-header">
        <h1 className="screen-title">My Projects</h1>
        <span className="screen-count">{ordered.length}</span>
      </header>

      {work.error && <p className="screen-error">{work.error}</p>}
      {!work.loading && ordered.length === 0 && (
        <p className="screen-empty">
          Nothing assigned to you yet — open work you own shows up here.
        </p>
      )}

      <div className="list">
        {groups.map((group) => (
          <section key={group.research.id} className="stage-section">
            <div className="stage-header">
              <span className="key-badge">{group.research.key}</span>
              <h2 className="stage-label stage-label--title">
                {group.research.title}
              </h2>
              <span className="stage-count">{group.tasks.length}</span>
            </div>
            {group.tasks.map((task) => {
              const i = cursor++;
              return (
                <TaskRow
                  key={task.id}
                  research={group.research}
                  task={task}
                  active={i === index}
                  rowRef={setRef(i)}
                  onFocus={() => select(i)}
                />
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
