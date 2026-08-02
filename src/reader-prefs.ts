/** Reading preferences: how the page looks, independent of which book. */

export type Theme = "paper" | "white" | "sepia" | "night";
/** "publisher" leaves the book's own typeface alone, as Books' Original does. */
export type FontChoice = "publisher" | "iowan" | "georgia" | "charter" | "system";

export interface ReaderPrefs {
  theme: Theme;
  font: FontChoice;
  /** Base size in px for body text. */
  size: number;
  lineHeight: number;
  /** Page margin in px; also sets the gutter between columns. */
  margin: number;
  justify: boolean;
}

export const DEFAULT_PREFS: ReaderPrefs = {
  theme: "paper",
  font: "publisher",
  size: 19,
  lineHeight: 1.62,
  margin: 56,
  justify: true,
};

const KEY = "bv.readerPrefs";

export function loadPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    // Merge so a preference added in a later version still gets a default.
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ReaderPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: ReaderPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* a full or blocked localStorage just means prefs don't persist */
  }
}

export const FONT_STACKS: Record<Exclude<FontChoice, "publisher">, string> = {
  iowan: "'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif",
  georgia: "Georgia,'Times New Roman',serif",
  charter: "Charter,'Bitstream Charter','Iowan Old Style',Georgia,serif",
  system: "-apple-system,'Segoe UI',system-ui,sans-serif",
};

export const FONT_LABELS: Record<FontChoice, string> = {
  publisher: "Publisher's font",
  iowan: "Iowan Old Style",
  georgia: "Georgia",
  charter: "Charter",
  system: "System sans",
};

export interface ThemeColors {
  bg: string;
  fg: string;
  link: string;
  /** Colour of the surround outside the page. */
  chrome: string;
  /**
   * Whether to override the book's own text colours.
   *
   * A tinted or dark page has to, because a publisher stylesheet that sets
   * near-black text would be unreadable on it. A plain light page does not, and
   * leaving it alone is what keeps the book looking as it was designed —
   * coloured headings, drop caps and all.
   */
  forceColors: boolean;
}

export const THEMES: Record<Theme, ThemeColors> = {
  paper: { bg: "#faf7f1", fg: "#1c1a17", link: "#0f766e", chrome: "#2a2622", forceColors: false },
  white: { bg: "#ffffff", fg: "#14141a", link: "#0f766e", chrome: "#1f1f23", forceColors: false },
  sepia: { bg: "#f4ecd8", fg: "#5b4636", link: "#8a5a2b", chrome: "#2e2820", forceColors: true },
  night: { bg: "#17171a", fg: "#c9c6c0", link: "#7cc4bd", chrome: "#0d0d0f", forceColors: true },
};
