import type { Assignee } from "@lykeion/api";
import { displayName, type Directory } from "../lib/assignee";
import "./components.css";

export function Avatar({
  assignee,
  dir,
}: {
  assignee: Assignee;
  dir: Directory;
}) {
  const label = displayName(assignee, dir);
  return (
    <span className="avatar" title={label} aria-hidden="true">
      {label.charAt(0)}
    </span>
  );
}
