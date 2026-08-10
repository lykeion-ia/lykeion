import type { FC } from "react";
import { cliIcon } from "./cli-icons";

/**
 * Presentation metadata for a detected agent CLI — a brand icon (or a 2-letter
 * monogram fallback when no icon is bundled) and a brand colour for the
 * switcher tiles. Keyed by the CLI's stable id (the same ids the ACP detection
 * surface reports). This styles *real* detected CLIs; it seeds no data of its
 * own — an unknown id falls back to its name's initials.
 */
interface CliBrand {
  icon: FC<{ className?: string }> | null;
  mono: string;
  /** Tile background (brand colour). */
  color: string;
  /** Glyph colour on the tile — light for dark-background brands. */
  fg: string;
}

const COLORS: Record<string, string> = {
  claude: "#d97757",
  codex: "#ffffff",
  gemini: "#5b8def",
  copilot: "#6e7681",
  cursor: "#8a86d8",
  opencode: "#3bb7c4",
  kimi: "#7a5cff",
  kiro: "#5b8def",
  qoder: "#4cc38a",
  codebuddy: "#3b82f6",
  hermes: "#b06ae0",
  openclaw: "#ffffff",
  pi: "#000000",
};

// Glyph colour override for brands whose tile is too dark for the default dark
// glyph. Everything else uses the near-black default.
const FGS: Record<string, string> = {
  pi: "#ffffff",
  openclaw: "#ef4444",
  claude: "#ffffff",
};

// Curated 2-letter monos for known ids (badge fallback when there's no icon).
const MONOS: Record<string, string> = {
  claude: "CC",
  codex: "CX",
  gemini: "GM",
  copilot: "CP",
  cursor: "CU",
  opencode: "OC",
  kimi: "KM",
  kiro: "KR",
  qoder: "QO",
  codebuddy: "CB",
  hermes: "HM",
  openclaw: "OW",
  pi: "PI",
};

/**
 * The colour a brand mark is drawn in when it stands on the page's own
 * background rather than on its filled chip.
 *
 * Not `COLORS`: those are TILE fills, chosen to be sat on, and three of them
 * would vanish used as ink — Codex and OpenClaw are white, Pi is black, and a
 * white glyph on a white page is a rendering fault rather than a brand. Those
 * three are absent here on purpose. A mark with no entry keeps whatever ink it
 * inherits, which is the honest rendering of a brand whose mark IS black or
 * white: it follows the reader's theme, the way the brand itself does.
 */
const INKS: Record<string, string> = {
  claude: "#d97757",
  gemini: "#5b8def",
  copilot: "#6e7681",
  cursor: "#8a86d8",
  opencode: "#3bb7c4",
  kimi: "#7a5cff",
  kiro: "#5b8def",
  qoder: "#4cc38a",
  codebuddy: "#3b82f6",
  hermes: "#b06ae0",
};

/** The brand's own colour to draw its mark in, or `null` to keep the ink the
 *  mark inherits (see `INKS`). */
export function cliInk(id: string): string | null {
  return INKS[id] ?? null;
}

export function cliBrand(id: string, name: string): CliBrand {
  // Fallback initials for an unrecognised id: first letter of up to the
  // first two words (e.g. "Weird Tool" -> "WT"), not just the name's first
  // two letters — so multi-word tool names read as a real monogram. For a
  // single-word name, fall back to that word's first two letters (e.g.
  // "Foo" -> "FO") so the result is always a 2-letter monogram.
  const words = name.match(/[A-Za-z]+/g) ?? [];
  const initials =
    (
      (words[0]?.[0] ?? "") + (words[1]?.[0] ?? words[0]?.[1] ?? "")
    ).toUpperCase() || "··";
  return {
    icon: cliIcon(id),
    mono: MONOS[id] ?? initials,
    color: COLORS[id] ?? "#55555c",
    fg: FGS[id] ?? "#0a0a0a",
  };
}
