import { useContext } from "react";
import { DirectoryContext } from "../api/ApiContext";
import type { Directory } from "../lib/assignee";

/**
 * The member directory, for resolving assignees to names and avatars.
 * `ApiProvider` fetches it once on mount; every caller reads that same
 * result rather than firing its own `listMembers()` request.
 */
export function useDirectory(): Directory {
  const dir = useContext(DirectoryContext);
  if (!dir)
    throw new Error("useDirectory() must be used inside <ApiProvider>");
  return dir;
}
