import type { ReactNode } from "react";
import "./components.css";

export type IconName =
  | "inbox"
  | "target"
  | "beaker"
  | "bot"
  | "sparkle"
  | "flow"
  | "chip"
  | "gear"
  | "search"
  | "play"
  | "flag"
  | "userplus"
  | "cycle"
  | "at"
  | "folder"
  | "document"
  | "sidebar"
  | "chat";

const PATHS: Record<IconName, ReactNode> = {
  inbox: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <path d="M2.5 9h3l1 1.5h3l1-1.5h3" />
    </>
  ),
  target: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  beaker: (
    <>
      <path d="M6.2 2.5h3.6" />
      <path d="M7 2.5v4.2l-3.1 5.2A1.5 1.5 0 0 0 5.2 14h5.6a1.5 1.5 0 0 0 1.3-2.1L9 6.7V2.5" />
      <path d="M5.2 10.5h5.6" />
    </>
  ),
  bot: (
    <>
      <rect x="3" y="5.5" width="10" height="7" rx="2" />
      <path d="M8 5.5V3.2" />
      <circle cx="8" cy="2.7" r="0.7" />
      <path d="M5.8 9h0.5M9.7 9h0.5" />
    </>
  ),
  sparkle: (
    <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7Z" />
  ),
  flow: (
    <>
      <circle cx="4" cy="4.2" r="1.7" />
      <circle cx="12" cy="4.2" r="1.7" />
      <circle cx="8" cy="11.8" r="1.7" />
      <path d="M4.8 5.7 7.3 10.3M11.2 5.7 8.7 10.3M5.7 4.2h4.6" />
    </>
  ),
  chip: (
    <>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
      <path d="M6.5 4.5v-2M9.5 4.5v-2M6.5 13.5v-2M9.5 13.5v-2M4.5 6.5h-2M4.5 9.5h-2M13.5 6.5h-2M13.5 9.5h-2" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2.5v1.8M8 11.7v1.8M2.5 8h1.8M11.7 8h1.8M4.1 4.1l1.3 1.3M10.6 10.6l1.3 1.3M11.9 4.1l-1.3 1.3M5.4 10.6l-1.3 1.3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  play: <path d="M6 4.5v7l5.5-3.5Z" />,
  flag: <path d="M4 13.5v-11M4 3h7.5L10 5.5 11.5 8H4" />,
  userplus: (
    <>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M2.5 13c.6-2.3 2.1-3.5 4-3.5s3.4 1.2 4 3.5" />
      <path d="M12.5 5.5v4M10.5 7.5h4" />
    </>
  ),
  cycle: (
    <>
      <path d="M12.7 6.2A5 5 0 0 0 4 4.8L3 6M3.3 9.8A5 5 0 0 0 12 11.2l1-1.2" />
      <path d="M3 3v3h3M13 13v-3h-3" />
    </>
  ),
  at: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M10.2 8v1a1.5 1.5 0 0 0 3 0V8a5.2 5.2 0 1 0-2 4.1" />
    </>
  ),
  folder: <path d="M2.5 5.2H6l1.2 1.3h6.3V12H2.5Z" />,
  document: (
    <>
      <path d="M4 2.5H8.5L12 6V13.5H4Z" />
      <path d="M8.5 2.5V6H12" />
      <path d="M6 9H10M6 11H10" />
    </>
  ),
  // A panel with its left column divided off — the standard "sidebar" glyph.
  sidebar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <path d="M6 3.5v9" />
    </>
  ),
  // A speech bubble with message lines — a chat conversation.
  chat: (
    <>
      <path d="M4.5 3H11.5A1.5 1.5 0 0 1 13 4.5V8.5A1.5 1.5 0 0 1 11.5 10H7L4.5 12.3V10A1.5 1.5 0 0 1 3 8.5V4.5A1.5 1.5 0 0 1 4.5 3Z" />
      <path d="M5.7 5.9H10.3M5.7 7.7H8.6" />
    </>
  ),
};

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      // Which glyph this is, for surfaces whose tests care that a row wears
      // the right one. Decorative to a reader either way.
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
