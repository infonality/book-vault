/**
 * Grouping comics into series.
 *
 * A comic library is mostly runs: a hundred volumes of one title sitting next
 * to a hundred volumes of another. Listing every issue at the top level buries
 * everything, so issues that belong together are collapsed into one shelf tile
 * that opens to reveal its volumes.
 *
 * The series name comes from the `series` field when a file carries one (a
 * `ComicInfo.xml` `<Series>` tag, or whatever the user typed in the drawer).
 * Most archives in the wild carry no tags at all, so failing that we read it
 * off the title, which for an untagged file is its filename.
 */

import { Book } from "./api";

/** Trailing decoration scanners and taggers leave behind: "(2013)", "[Digital]". */
const TRAILING_BRACKETS = /\s*[([][^()[\]]*[)\]]\s*$/;

/**
 * Ways a volume or issue number is written at the end of a title. Ordered most
 * specific first — an explicit marker ("v03", "第3巻") is stronger evidence
 * than a bare number, which could be anything.
 */
const VOLUME_PATTERNS: RegExp[] = [
  // Japanese volume/chapter markers: 第100巻, 第01話, 第3集.
  /^(.*?)[\s\-–—:]*第\s*(\d{1,4})\s*[巻卷話集]$/,
  // "Saga #12", "Saga № 12"
  /^(.*?)[\s\-–—:]*[#№]\s*(\d{1,4})$/,
  // "Saga v01", "Saga Vol. 3", "Saga Volume 3"
  /^(.*?)[\s\-–—:]*(?:vol|volume|v)\.?\s*(\d{1,4})$/i,
  // "Saga Chapter 4", "Saga Issue 7", "Saga No. 2"
  /^(.*?)[\s\-–—:]*(?:ch|chapter|issue|no)\.?\s*(\d{1,4})$/i,
  // A bare trailing number, which needs a separator in front of it. Capped at
  // three digits unless zero-padded so that a year — "Watchmen 1986" — isn't
  // mistaken for volume 1986.
  /^(.*?)[\s\-–—:]+(\d{1,3}|0\d{3})$/,
];

/** Split a title into the run it belongs to and its number within that run. */
export function parseTitle(title: string): { base: string; volume: number | null } {
  let t = title.trim();
  // Peel off any number of trailing bracketed groups.
  for (let i = 0; i < 4 && TRAILING_BRACKETS.test(t); i++) {
    t = t.replace(TRAILING_BRACKETS, "").trim();
  }

  for (const re of VOLUME_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    const base = m[1].trim().replace(/[\s\-–—:,]+$/, "");
    const n = parseInt(m[2], 10);
    // A number with nothing in front of it isn't a series — it's just a name.
    if (base) return { base, volume: Number.isFinite(n) ? n : null };
  }
  return { base: t, volume: null };
}

/** The series a book belongs to, and where it sits in that series. */
export function seriesOf(b: Book): { name: string; volume: number | null } {
  const parsed = parseTitle(b.title);
  const tagged = b.series?.trim();
  return { name: tagged || parsed.base || b.title, volume: parsed.volume };
}

function keyOf(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export type SeriesGroup = {
  kind: "series";
  key: string;
  name: string;
  /** Volumes, ordered by number where we could read one. */
  books: Book[];
  finished: number;
};

export type Shelf = SeriesGroup | { kind: "single"; key: string; book: Book };

/**
 * Collapse a flat list into shelves. A series needs at least two volumes to be
 * worth hiding behind a tile; a lone book stays where the reader can see it.
 */
export function groupBySeries(books: Book[]): Shelf[] {
  const groups = new Map<string, { name: string; books: Book[] }>();
  const order: string[] = [];

  for (const b of books) {
    const { name } = seriesOf(b);
    const key = keyOf(name);
    let g = groups.get(key);
    if (!g) {
      g = { name, books: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.books.push(b);
  }

  return order.map((key) => {
    const g = groups.get(key)!;
    if (g.books.length < 2) return { kind: "single", key, book: g.books[0] } as Shelf;
    return {
      kind: "series",
      key,
      name: g.name,
      books: sortVolumes(g.books),
      finished: g.books.filter((b) => b.status === "finished").length,
    } as Shelf;
  });
}

/** Reading order: by volume number, with unnumbered stragglers by title. */
export function sortVolumes(books: Book[]): Book[] {
  return [...books].sort((a, b) => {
    const va = seriesOf(a).volume;
    const vb = seriesOf(b).volume;
    if (va != null && vb != null && va !== vb) return va - vb;
    if (va != null && vb == null) return -1;
    if (va == null && vb != null) return 1;
    return a.title.localeCompare(b.title);
  });
}

/** The cover to put on the shelf tile: the earliest volume that has one. */
export function shelfCover(g: SeriesGroup): Book | null {
  return g.books.find((b) => b.cover_path) ?? g.books[0] ?? null;
}
