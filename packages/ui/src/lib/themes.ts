/**
 * Theme catalog for the Settings › Appearance tab. The actual palettes live in CSS
 * (tokens.css `[data-theme="..."]` blocks); this is display metadata only —
 * the id must match the CSS selector, and the swatch colors mirror the seeds so
 * the picker previews a theme without applying it. `DEFAULT_THEME` matches the
 * core's boot default and the tokens.css `:root` seeds.
 */
export const DEFAULT_THEME = "midnight";

export interface ThemeSwatch {
  /** Seed background (canvas). */
  bg: string;
  /** Seed ink (text). */
  ink: string;
  /** Seed surface (cards, rails). */
  surface: string;
  /** Seed accent (primary). */
  accent: string;
  /** Ink shown on top of the accent. */
  onAccent: string;
}

export interface ThemeMeta {
  /** Matches the tokens.css `[data-theme="<id>"]` selector. */
  id: string;
  label: string;
  /** One-line character note shown under the name. */
  blurb: string;
  swatch: ThemeSwatch;
}

export const THEMES: ThemeMeta[] = [
  {
    id: "midnight",
    label: "Midnight",
    blurb: "Near-black with a rose accent — the default.",
    swatch: {
      bg: "#0F0F10",
      ink: "#EEEFF1",
      surface: "#151516",
      accent: "#D25E65",
      onAccent: "#FFFFFF",
    },
  },
  {
    id: "ash",
    label: "Ash",
    blurb: "Clean white light theme with a slate-blue accent.",
    swatch: {
      bg: "#FFFFFF",
      ink: "#44494D",
      surface: "#EDEEF3",
      accent: "#475BA1",
      onAccent: "#FFFFFF",
    },
  },
  {
    id: "dawn",
    label: "Dawn",
    blurb: "Warm plum dark theme with a magenta accent.",
    swatch: {
      bg: "#2A222E",
      ink: "#EEEFF1",
      surface: "#382A3C",
      accent: "#A84376",
      onAccent: "#FFFFFF",
    },
  },
  {
    id: "pale",
    label: "Pale",
    blurb: "Cool indigo dark theme with a violet accent.",
    swatch: {
      bg: "#292D3E",
      ink: "#EEEFF1",
      surface: "#292D3E",
      accent: "#7D57C1",
      onAccent: "#FFFFFF",
    },
  },
  {
    id: "barbie",
    label: "Barbie Dreamhouse",
    blurb: "Lavender-and-pink light theme with a cyan accent.",
    swatch: {
      bg: "#E2DAF1",
      ink: "#593E74",
      surface: "#FCDEEE",
      accent: "#B8FAFA",
      onAccent: "#8B6BC7",
    },
  },
];

/** The set of valid theme ids (for validating a stored/persisted value). */
export const THEME_IDS = new Set(THEMES.map((t) => t.id));

/** Apply a theme to the document by id. Falls back to the default when unknown. */
export function applyTheme(id: string): void {
  const next = THEME_IDS.has(id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = next;
}

const THEME_KEY = "lykeion.theme";

/**
 * This browser's record of the chosen theme.
 *
 * A theme has to be readable before anything is fetched, or every load paints
 * the default first and re-tints once the answer arrives. With no workspace
 * server behind the page there is nowhere else for it to live at all: the
 * in-browser core is rebuilt from seed on every load, so a choice kept only
 * there is gone the moment the tab reloads.
 *
 * An unknown id is treated as no answer rather than passed on — the catalog
 * can drop a theme between visits, and `applyTheme` would silently substitute
 * the default for it anyway.
 *
 * Storage is not always there to be read: a profile with site data blocked
 * throws on access rather than answering empty, and jsdom offers an object
 * with none of Storage's methods. That costs the page its memory of the pick
 * and nothing else, so both directions fail quiet.
 */
export function storedTheme(): string | null {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return raw !== null && THEME_IDS.has(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function storeTheme(id: string): void {
  try {
    window.localStorage.setItem(THEME_KEY, id);
  } catch {
    return;
  }
}
