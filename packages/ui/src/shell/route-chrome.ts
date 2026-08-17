/**
 * What a route is called, and what it looks like, in the tab strip.
 *
 * Pure, and derived from the route alone. A tab's glyph is therefore never
 * stored — it cannot fall out of step with the route it decorates — and a label
 * is stored only where it cannot be derived, which is a Task's or a Study's
 * title. These are what the strip draws until the screen that read the subject
 * says better, and on a cold entry they are all there is.
 *
 * The rail's own `NAV_ALL` is the source for every screen that appears in it, so
 * a section renamed there is renamed in the strip too, in one edit. Only routes
 * the rail has no entry for are spelled out below.
 */
import type { ComponentType, SVGProps } from "react";
import {
  FlaskIcon,
  InboxIcon,
  SparkleIcon,
  WorkflowIcon,
} from "../components/icons";
import { NAV_ALL } from "./nav";
import type { Route } from "../router";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

/** The rail entry for a route, matched on name alone — so a Settings route
 *  deep-linked to a tab still finds the one Settings entry. */
const navEntry = (route: Route) =>
  NAV_ALL.find((e) => e.route.name === route.name);

export function routeLabel(route: Route): string {
  switch (route.name) {
    // The generic name of the kind, replaced by `reconcileLabel` once the
    // screen has read the subject's real title.
    case "task":
    case "unfiled-task":
      return "Task";
    case "study":
      return "Study";
    // The id, not the name: the name needs a read, and a tab that filled in
    // afterwards would change under the reader for the length of one fetch.
    case "agent":
      return route.agentId;
    case "workflow":
      return route.workflowId;
    default:
      return navEntry(route)?.label ?? "Inbox";
  }
}

export function routeGlyph(route: Route): IconType {
  switch (route.name) {
    // A Task is read inside a Study, so both carry the Study's mark.
    case "task":
    case "unfiled-task":
    case "study":
      return FlaskIcon;
    // Singular route names the rail has no entry for — its entries are the
    // sections, `agents` and `workflows`.
    case "agent":
      return SparkleIcon;
    case "workflow":
      return WorkflowIcon;
    default:
      return navEntry(route)?.icon ?? InboxIcon;
  }
}
