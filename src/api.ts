// Typed wrappers around the Rust command surface.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export type Status = "unread" | "reading" | "finished";
/** Comics live in their own root and their own section; format can't tell them
 *  apart from books, since plenty of comics are PDFs. */
export type Kind = "book" | "comic";

export interface Book {
  id: number;
  path: string;
  filename: string;
  format: string;
  size: number;
  title: string;
  author: string | null;
  series: string | null;
  publisher: string | null;
  published_date: string | null;
  language: string | null;
  isbn: string | null;
  description: string | null;
  category: string | null;
  subjects: string | null;
  cover_path: string | null;
  pages: number | null;
  words: number | null;
  words_estimated: boolean;
  status: Status;
  current_page: number;
  rating: number | null;
  meta_status: string; // none | embedded | fetched | manual
  meta_source: string | null;
  started_at: number | null;
  finished_at: number | null;
  /** Unix seconds; last time we handed the file to the system reader. */
  last_opened_at: number | null;
  /** Opaque JSON position from the built-in reader. */
  locator: string | null;
  /** book | comic — which section of the library this belongs to. */
  kind: Kind;
  added_at: number;
  updated_at: number;
}

/** Fields the detail drawer can edit directly. */
export interface BookEdit {
  title: string;
  author: string | null;
  series: string | null;
  publisher: string | null;
  published_date: string | null;
  language: string | null;
  isbn: string | null;
  description: string | null;
  category: string | null;
  subjects: string | null;
  pages: number | null;
  words: number | null;
}

export interface Settings {
  books_root: string;
  comics_root: string;
  words_per_page: number;
}

export interface CategoryStat {
  name: string;
  total: number;
  finished: number;
}

export interface DashboardStats {
  total_books: number;
  finished_books: number;
  reading_books: number;
  unread_books: number;
  pages_read: number;
  words_read: number;
  avg_rating: number | null;
  categories: CategoryStat[];
  recent_finished: Book[];
  in_progress: Book[];
  total_comics: number;
  finished_comics: number;
}

export interface MetaCandidate {
  title: string;
  author: string | null;
  year: number | null;
  pages: number | null;
  publisher: string | null;
  isbn: string | null;
  subjects: string | null;
  cover_url: string | null;
  work_key: string | null;
}

export interface ScanResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

/** Popular preset shelves/genres offered in the category picker. */
export const POPULAR_CATEGORIES: string[] = [
  "Fiction",
  "Non-Fiction",
  "Science Fiction",
  "Fantasy",
  "Mystery",
  "Thriller",
  "Romance",
  "Horror",
  "Historical Fiction",
  "Biography",
  "Memoir",
  "History",
  "Science",
  "Technology",
  "Business",
  "Self-Help",
  "Philosophy",
  "Psychology",
  "Poetry",
  "Classics",
  "Young Adult",
  "Children's",
  "Graphic Novels",
  "Cookbook",
  "Travel",
  "Religion & Spirituality",
  "Politics",
  "Reference",
  "Education",
  "To Read",
  "Favorites",
];

// ---------------- built-in reader ----------------

export interface SpineItem {
  index: number;
  path: string;
  chars: number;
}

export interface TocEntry {
  label: string;
  spine_index: number | null;
  fragment: string | null;
  depth: number;
}

export interface ReaderSession {
  spine: SpineItem[];
  toc: TocEntry[];
  total_chars: number;
  /** Base URL the reader frame resolves the book's own assets against. */
  resource_base: string;
  locator: string | null;
  title: string;
}

export interface Chapter {
  index: number;
  html: string;
  /** Directory of this document inside the archive. */
  dir: string;
  chars: number;
}

/** Where the reader left off. Stored as a ratio so it survives reflow. */
export interface Locator {
  spine: number;
  ratio: number;
}

export interface SearchHit {
  spine: number;
  /** Which occurrence within its chapter, so the reader can find it in the DOM. */
  occurrence: number;
  snippet: string;
}

export type AnnotationKind = "highlight" | "bookmark";

export interface Annotation {
  id: number;
  book_id: number;
  spine: number;
  start_off: number;
  end_off: number;
  kind: AnnotationKind;
  color: string;
  text: string;
  note: string | null;
  created_at: number;
}

export interface ProgressEvent {
  job: string;
  current: number;
  total: number;
  message: string;
  done: boolean;
}

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),

  listBooks: () => invoke<Book[]>("list_books"),
  getBook: (id: number) => invoke<Book | null>("get_book", { id }),
  listCategories: () => invoke<string[]>("list_categories"),
  dashboardStats: () => invoke<DashboardStats>("dashboard_stats"),

  scanLibrary: () => invoke<ScanResult>("scan_library"),

  updateBook: (id: number, edit: BookEdit) => invoke<Book>("update_book", { id, edit }),
  setStatus: (id: number, status: Status) => invoke<Book>("set_status", { id, status }),
  setProgress: (id: number, currentPage: number) =>
    invoke<Book>("set_progress", { id, currentPage }),
  setRating: (id: number, rating: number | null) => invoke<Book>("set_rating", { id, rating }),
  /** Open the file in the OS default reader for its type. */
  openBook: (id: number) => invoke<Book>("open_book", { id }),
  deleteBook: (id: number) => invoke<void>("delete_book", { id }),

  readerOpen: (id: number) => invoke<ReaderSession>("reader_open", { id }),
  readerChapter: (id: number, index: number) =>
    invoke<Chapter>("reader_chapter", { id, index }),
  readerSavePosition: (id: number, locator: string, percent: number) =>
    invoke<Book>("reader_save_position", { id, locator, percent }),

  readerSearch: (id: number, query: string) =>
    invoke<SearchHit[]>("reader_search", { id, query }),

  listAnnotations: (bookId: number) => invoke<Annotation[]>("list_annotations", { bookId }),
  addAnnotation: (a: {
    bookId: number;
    spine: number;
    startOff: number;
    endOff: number;
    kind: AnnotationKind;
    color: string;
    text: string;
  }) => invoke<Annotation>("add_annotation", a),
  updateAnnotation: (id: number, note: string | null, color: string | null) =>
    invoke<void>("update_annotation", { id, note, color }),
  deleteAnnotation: (id: number) => invoke<void>("delete_annotation", { id }),

  searchMetadata: (query: string) => invoke<MetaCandidate[]>("search_metadata", { query }),
  applyMetadata: (id: number, candidate: MetaCandidate) =>
    invoke<Book>("apply_metadata", { id, candidate }),
};

/** Turn an absolute local file path into a URL the webview can render. */
export function assetUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return convertFileSrc(path);
}

/** Open the native folder picker; returns the chosen path or undefined. */
export async function pickFolder(title?: string): Promise<string | undefined> {
  const result = await open({ directory: true, multiple: false, title });
  if (typeof result === "string") return result;
  return undefined;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** "18 min" / "1 h 25 min" — used for how long a reading session ran. */
export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Compact number formatting for large word/page totals. */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
