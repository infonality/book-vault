/**
 * How the app itself looks: light or dark, and which accent.
 *
 * Both are applied as attributes on the root element, and every colour in the
 * UI resolves through CSS custom properties that those attributes redefine (see
 * index.css). That is what makes a theme switch a one-line change rather than a
 * rewrite of several hundred utility classes — Tailwind compiles
 * `text-slate-400` to `color: var(--color-slate-400)`, so moving the variable
 * moves everything that referenced it.
 *
 * This is the *chrome*. What a page of a book looks like is a separate,
 * per-reader setting in reader-prefs, because the two answer different
 * questions: one is the app you are using, the other is the paper you are
 * reading off.
 */

export type AppTheme = "dark" | "light";

/** Accent presets. The values live in index.css, keyed by these ids. */
export const ACCENTS = [
  { id: "teal", label: "Teal", swatch: "#14b8a6" },
  { id: "violet", label: "Violet", swatch: "#8b5cf6" },
  { id: "sky", label: "Sky", swatch: "#0ea5e9" },
  { id: "emerald", label: "Emerald", swatch: "#10b981" },
  { id: "amber", label: "Amber", swatch: "#f59e0b" },
  { id: "rose", label: "Rose", swatch: "#f43f5e" },
] as const;

export type Accent = (typeof ACCENTS)[number]["id"];

export interface Appearance {
  theme: AppTheme;
  accent: Accent;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: "dark", accent: "teal" };

const KEY = "bv.appearance";

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const saved = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: saved.theme === "light" ? "light" : "dark",
      // Guard the accent: a preset removed in a later version must not leave
      // the UI referring to variables that no longer exist.
      accent: ACCENTS.some((a) => a.id === saved.accent)
        ? (saved.accent as Accent)
        : DEFAULT_APPEARANCE.accent,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(a: Appearance) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* a full or blocked localStorage just means it doesn't persist */
  }
}

/**
 * Put the appearance on the document.
 *
 * `theme` is deliberately optional. The reader window shares this bundle but
 * keeps its own dark chrome around the page, so it applies the accent and
 * leaves the light/dark attribute off — a light chrome behind a night-mode page
 * would be a lamp pointed at the reader.
 */
export function applyAppearance(a: Appearance, opts: { theme?: boolean } = {}) {
  const root = document.documentElement;
  root.dataset.accent = a.accent;
  if (opts.theme === false) delete root.dataset.theme;
  else root.dataset.theme = a.theme;
}
