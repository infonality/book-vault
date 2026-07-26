import { useEffect, useMemo, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  assetUrl,
  Book,
  BookEdit,
  formatCompact,
  MetaCandidate,
  POPULAR_CATEGORIES,
  Status,
} from "../api";
import { Badge, Button, Icon, Spinner, StarRating, cx, statusMeta } from "../ui";

type SortKey = "title" | "author" | "category" | "status" | "progress" | "rating" | "pages" | "words";
type StatusFilter = "all" | Status;
type ViewMode = "list" | "grid";

const VIEW_KEY = "bv.libraryView";

function loadViewMode(): ViewMode {
  return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
}

const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "reading", label: "Reading" },
  { id: "finished", label: "Finished" },
];

function progressPct(b: Book): number {
  if (b.status === "finished") return 100;
  if (b.pages && b.pages > 0) return Math.min(100, Math.round((b.current_page / b.pages) * 100));
  return 0;
}

export default function Library({
  reloadToken,
  onReload,
  onOpen,
}: {
  reloadToken: number;
  onReload: () => void;
  /** Hands the book to the system reader; resolves with the updated row. */
  onOpen: (book: Book) => Promise<Book>;
}) {
  const [books, setBooks] = useState<Book[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "title", dir: 1 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<ViewMode>(loadViewMode);

  // Remember the last chosen layout across launches.
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([api.listBooks(), api.listCategories()])
      .then(([b, c]) => {
        if (!alive) return;
        setBooks(b);
        setCategories(c);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [reloadToken]);

  const selected = useMemo(() => books.find((b) => b.id === selectedId) ?? null, [books, selectedId]);

  const upsert = (b: Book) => setBooks((prev) => prev.map((x) => (x.id === b.id ? b : x)));

  async function openInReader(book: Book) {
    try {
      upsert(await onOpen(book));
    } catch (e) {
      alert(String(e));
    }
  }

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const b of books) {
      const key = b.category && b.category.trim() ? b.category : "Uncategorized";
      c.set(key, (c.get(key) ?? 0) + 1);
    }
    return c;
  }, [books]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = books.filter((b) => {
      if (status !== "all" && b.status !== status) return false;
      if (category !== "all") {
        const cat = b.category && b.category.trim() ? b.category : "Uncategorized";
        if (cat !== category) return false;
      }
      if (q) {
        const hay = `${b.title} ${b.author ?? ""} ${b.series ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sort.dir;
    const val = (b: Book): string | number => {
      switch (sort.key) {
        case "author":
          return (b.author ?? "").toLowerCase();
        case "category":
          return (b.category ?? "").toLowerCase();
        case "status":
          return b.status;
        case "progress":
          return progressPct(b);
        case "rating":
          return b.rating ?? -1;
        case "pages":
          return b.pages ?? -1;
        case "words":
          return b.words ?? -1;
        default:
          return b.title.toLowerCase();
      }
    };
    return [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return a.title.localeCompare(b.title);
    });
  }, [books, status, category, search, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }

  const categoryOptions = useMemo(() => Array.from(counts.keys()).sort(), [counts]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="mt-1 text-sm text-slate-400">
            {filtered.length.toLocaleString()} {filtered.length === 1 ? "book" : "books"}
            {status !== "all" && ` · ${status}`}
          </p>
        </div>
      </header>

      {/* Status tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setStatus(t.id)}
            className={cx(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              status === t.id
                ? "border-teal-500/40 bg-teal-500/20 text-white"
                : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
            )}
          >
            {t.label}
            <span className="ml-1 text-slate-500">
              {t.id === "all" ? books.length : books.filter((b) => b.status === t.id).length}
            </span>
          </button>
        ))}
      </div>

      {/* Search + category */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, author, series…"
            className="w-full rounded-lg border border-white/10 bg-white/5 py-2.5 pl-10 pr-3 text-sm outline-none placeholder:text-slate-500 focus:border-teal-500/50"
          />
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm outline-none focus:border-teal-500/50"
        >
          <option value="all">All categories</option>
          {categoryOptions.map((c) => (
            <option key={c} value={c}>
              {c} ({counts.get(c)})
            </option>
          ))}
        </select>

        {/* Layout toggle */}
        <div className="flex shrink-0 gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5">
          {([
            { id: "list" as ViewMode, icon: "list", label: "List view" },
            { id: "grid" as ViewMode, icon: "grid", label: "Grid view" },
          ]).map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              title={v.label}
              aria-label={v.label}
              aria-pressed={view === v.id}
              className={cx(
                "rounded-md px-2.5 py-2 transition-colors",
                view === v.id ? "bg-teal-600 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
              )}
            >
              <Icon name={v.icon} className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 py-10 text-slate-400">
          <Spinner className="h-5 w-5" /> Loading library…
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">
          {books.length === 0 ? "No books yet — set your folder and scan." : "No books match these filters."}
        </p>
      ) : view === "grid" ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {filtered.map((b) => (
            <BookCard
              key={b.id}
              book={b}
              active={b.id === selectedId}
              onClick={() => setSelectedId(b.id)}
              onOpen={() => openInReader(b)}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/[0.03] text-left text-xs text-slate-400">
                <Th onClick={() => toggleSort("title")} sort={sort} col="title" className="pl-4">Title</Th>
                <Th onClick={() => toggleSort("author")} sort={sort} col="author">Author</Th>
                <Th onClick={() => toggleSort("category")} sort={sort} col="category">Category</Th>
                <Th onClick={() => toggleSort("status")} sort={sort} col="status">Status</Th>
                <Th onClick={() => toggleSort("progress")} sort={sort} col="progress">Progress</Th>
                <Th onClick={() => toggleSort("rating")} sort={sort} col="rating">Rating</Th>
                <Th onClick={() => toggleSort("pages")} sort={sort} col="pages" className="text-right">Pages</Th>
                <Th onClick={() => toggleSort("words")} sort={sort} col="words" className="pr-4 text-right">Words</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((b, i) => (
                <BookRow
                  key={b.id}
                  book={b}
                  striped={i % 2 === 1}
                  active={b.id === selectedId}
                  onClick={() => setSelectedId(b.id)}
                  onOpen={() => openInReader(b)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <BookDrawer
          key={selected.id}
          book={selected}
          categories={categories}
          onClose={() => setSelectedId(null)}
          onChange={upsert}
          onOpen={() => openInReader(selected)}
          onDeleted={(id) => {
            setBooks((prev) => prev.filter((x) => x.id !== id));
            setSelectedId(null);
            onReload();
          }}
        />
      )}
    </div>
  );
}

function Th({
  children,
  onClick,
  sort,
  col,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  sort: { key: SortKey; dir: 1 | -1 };
  col: SortKey;
  className?: string;
}) {
  const active = sort.key === col;
  return (
    <th className={cx("select-none px-3 py-2.5 font-medium", className)}>
      <button onClick={onClick} className={cx("inline-flex items-center gap-1 hover:text-slate-200", active && "text-slate-200")}>
        {children}
        {active && <span className="text-[10px]">{sort.dir === 1 ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

function BookRow({
  book,
  striped,
  active,
  onClick,
  onOpen,
}: {
  book: Book;
  striped: boolean;
  active: boolean;
  onClick: () => void;
  onOpen: () => void;
}) {
  const pct = progressPct(book);
  const sm = statusMeta(book.status);
  const img = assetUrl(book.cover_path);
  return (
    <tr
      onClick={onClick}
      onDoubleClick={onOpen}
      className={cx(
        "group cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.05]",
        active ? "bg-teal-500/10" : striped ? "bg-white/[0.015]" : ""
      )}
    >
      <td className="py-2 pl-4 pr-3">
        <div className="flex items-center gap-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            title={`Read in your default ${book.format.toUpperCase()} reader`}
            className="relative h-11 w-8 shrink-0 overflow-hidden rounded bg-slate-800"
          >
            {img ? (
              <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <div className="grid h-full w-full place-items-center text-slate-600">
                <Icon name="book" className="h-4 w-4" />
              </div>
            )}
            <span className="absolute inset-0 grid place-items-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100">
              <Icon name="read" className="h-4 w-4 text-white" />
            </span>
          </button>
          <div className="min-w-0">
            <div className="truncate font-medium text-slate-100">{book.title}</div>
            <div className="truncate text-[11px] uppercase tracking-wide text-slate-500">{book.format}</div>
          </div>
        </div>
      </td>
      <td className="px-3 text-slate-300">
        <span className="line-clamp-1">{book.author ?? "—"}</span>
      </td>
      <td className="px-3 text-slate-400">{book.category?.trim() || "—"}</td>
      <td className="px-3">
        <Badge tone={sm.tone}>{sm.label}</Badge>
      </td>
      <td className="px-3">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
            <div
              className={cx("h-full rounded-full", book.status === "finished" ? "bg-emerald-500" : "bg-teal-500")}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="w-8 text-[11px] tabular-nums text-slate-400">{pct}%</span>
        </div>
      </td>
      <td className="px-3">
        {book.rating != null ? <StarRating value={book.rating} size="h-3.5 w-3.5" /> : <span className="text-slate-600">—</span>}
      </td>
      <td className="px-3 text-right tabular-nums text-slate-300">{book.pages?.toLocaleString() ?? "—"}</td>
      <td className="py-2 pl-3 pr-4 text-right tabular-nums text-slate-300">
        {book.words != null ? (
          <span title={book.words.toLocaleString()}>
            {book.words_estimated ? "~" : ""}
            {formatCompact(book.words)}
          </span>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}

/** Grid tile: cover plus title, nothing else. Same interactions as a row —
 *  click selects, double-click (or the hover button) opens the reader. */
function BookCard({
  book,
  active,
  onClick,
  onOpen,
}: {
  book: Book;
  active: boolean;
  onClick: () => void;
  onOpen: () => void;
}) {
  const img = assetUrl(book.cover_path);
  return (
    <div className="group cursor-pointer" onClick={onClick} onDoubleClick={onOpen}>
      <div
        className={cx(
          "relative aspect-[2/3] overflow-hidden rounded-lg border bg-slate-800 transition-colors",
          active ? "border-teal-500/60 ring-2 ring-teal-500/25" : "border-white/10 group-hover:border-white/25"
        )}
      >
        {img ? (
          <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="grid h-full w-full place-items-center text-slate-600">
            <Icon name="book" className="h-8 w-8" />
          </div>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title={`Read in your default ${book.format.toUpperCase()} reader`}
          className="absolute inset-0 grid place-items-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <span className="rounded-full bg-white/15 p-2.5 backdrop-blur">
            <Icon name="read" className="h-5 w-5 text-white" />
          </span>
        </button>
      </div>
      <div
        className={cx(
          "mt-2 line-clamp-2 text-[13px] font-medium leading-snug",
          active ? "text-white" : "text-slate-300"
        )}
        title={book.title}
      >
        {book.title}
      </div>
    </div>
  );
}

// ---------------- detail drawer ----------------

function BookDrawer({
  book,
  categories,
  onClose,
  onChange,
  onDeleted,
  onOpen,
}: {
  book: Book;
  categories: string[];
  onClose: () => void;
  onChange: (b: Book) => void;
  onDeleted: (id: number) => void;
  onOpen: () => Promise<void>;
}) {
  const [form, setForm] = useState<BookEdit>(toEdit(book));
  const [savingEdit, setSavingEdit] = useState(false);
  const [opening, setOpening] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [candidates, setCandidates] = useState<MetaCandidate[] | null>(null);
  const [query, setQuery] = useState(`${book.title} ${book.author ?? ""}`.trim());
  const [busyStatus, setBusyStatus] = useState(false);

  const img = assetUrl(book.cover_path);
  const dirty = JSON.stringify(form) !== JSON.stringify(toEdit(book));

  // Categories already in use, followed by popular presets, de-duplicated.
  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of [...categories, ...POPULAR_CATEGORIES]) {
      const key = c.trim();
      if (key && !seen.has(key.toLowerCase())) {
        seen.add(key.toLowerCase());
        out.push(key);
      }
    }
    return out;
  }, [categories]);

  function set<K extends keyof BookEdit>(key: K, value: BookEdit[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function saveEdit() {
    setSavingEdit(true);
    try {
      const updated = await api.updateBook(book.id, normalize(form));
      onChange(updated);
    } catch (e) {
      alert(String(e));
    } finally {
      setSavingEdit(false);
    }
  }

  async function changeStatus(status: Status) {
    setBusyStatus(true);
    try {
      onChange(await api.setStatus(book.id, status));
    } catch (e) {
      alert(String(e));
    } finally {
      setBusyStatus(false);
    }
  }

  async function changeProgress(page: number) {
    try {
      onChange(await api.setProgress(book.id, page));
    } catch (e) {
      alert(String(e));
    }
  }

  async function changeRating(r: number | null) {
    try {
      onChange(await api.setRating(book.id, r));
    } catch (e) {
      alert(String(e));
    }
  }

  async function runFetch() {
    setFetching(true);
    setCandidates(null);
    try {
      setCandidates(await api.searchMetadata(query));
    } catch (e) {
      alert(String(e));
    } finally {
      setFetching(false);
    }
  }

  async function applyCandidate(c: MetaCandidate) {
    setFetching(true);
    try {
      const updated = await api.applyMetadata(book.id, c);
      onChange(updated);
      setForm(toEdit(updated));
      setCandidates(null);
    } catch (e) {
      alert(String(e));
    } finally {
      setFetching(false);
    }
  }

  async function del() {
    if (!confirm(`Remove "${book.title}" from the library?\n\nThis only removes it from Book Vault — the file on disk is left untouched.`))
      return;
    try {
      await api.deleteBook(book.id);
      onDeleted(book.id);
    } catch (e) {
      alert(String(e));
    }
  }

  async function openFile() {
    try {
      await revealItemInDir(book.path);
    } catch (e) {
      alert(String(e));
    }
  }

  async function read() {
    setOpening(true);
    try {
      await onOpen();
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bv-fade flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-white/10 bg-slate-950/95 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-slate-950/95 px-5 py-4 backdrop-blur">
          <span className="text-sm font-medium text-slate-400">Book details</span>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 p-5">
          {/* Header: cover + title + reading state */}
          <div className="flex gap-4">
            <div className="h-44 w-30 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-slate-800" style={{ width: "8rem" }}>
              {img ? (
                <img src={img} alt={book.title} className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-slate-600">
                  <Icon name="book" className="h-8 w-8" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold leading-tight">{book.title}</h2>
              <p className="mt-0.5 text-sm text-slate-400">{book.author ?? "Unknown author"}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge tone="slate">{book.format.toUpperCase()}</Badge>
                {book.category?.trim() && <Badge tone="teal">{book.category}</Badge>}
                {book.meta_status === "fetched" && <Badge tone="blue">Open Library</Badge>}
                {book.meta_status === "manual" && <Badge tone="amber">Edited</Badge>}
              </div>
              <div className="mt-3">
                <div className="mb-1 text-xs text-slate-500">Your rating</div>
                <StarRating value={book.rating} onChange={changeRating} size="h-5 w-5" />
              </div>
            </div>
          </div>

          {/* Open in the OS default reader for this format */}
          <div>
            <Button
              variant="primary"
              className="w-full justify-center"
              busy={opening}
              onClick={read}
            >
              {!opening && <Icon name="read" className="h-4 w-4" />}
              {opening ? "Opening…" : "Read now"}
            </Button>
            <p className="mt-1.5 text-center text-[11px] text-slate-500">
              Opens in your default {book.format.toUpperCase()} reader. We'll ask where you got to
              when you come back.
            </p>
          </div>

          {/* Status segmented control */}
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Reading status</div>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1">
              {(["unread", "reading", "finished"] as Status[]).map((st) => {
                const active = book.status === st;
                return (
                  <button
                    key={st}
                    disabled={busyStatus}
                    onClick={() => changeStatus(st)}
                    className={cx(
                      "rounded-md py-1.5 text-xs font-medium capitalize transition-colors disabled:opacity-50",
                      active ? "bg-teal-600 text-white" : "text-slate-300 hover:bg-white/5"
                    )}
                  >
                    {st}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Progress */}
          <ProgressControl book={book} onSet={changeProgress} />

          {/* Fetch metadata */}
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <Icon name="sparkles" className="h-3.5 w-3.5 text-teal-400" />
              <span className="text-xs font-semibold text-slate-300">Fetch metadata (Open Library)</span>
            </div>
            <div className="flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && query.trim() && runFetch()}
                placeholder="Title and author…"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-teal-500/50"
              />
              <Button variant="primary" busy={fetching} onClick={runFetch} disabled={!query.trim()}>
                {!fetching && <Icon name="search" className="h-4 w-4" />} Search
              </Button>
            </div>

            {candidates && (
              <div className="mt-3 space-y-2">
                {candidates.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No matches. Edit the fields below and save to enter the details yourself.
                  </p>
                ) : (
                  candidates.map((c, i) => (
                    <button
                      key={i}
                      onClick={() => applyCandidate(c)}
                      disabled={fetching}
                      className="flex w-full items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-2 text-left transition-colors hover:border-teal-500/40 hover:bg-white/[0.06] disabled:opacity-50"
                    >
                      <div className="h-14 w-10 shrink-0 overflow-hidden rounded bg-slate-800">
                        {c.cover_url ? (
                          <img src={c.cover_url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-slate-600">
                            <Icon name="book" className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{c.title}</div>
                        <div className="truncate text-xs text-slate-400">
                          {c.author ?? "Unknown"}
                          {c.year ? ` · ${c.year}` : ""}
                          {c.pages ? ` · ${c.pages} pp` : ""}
                        </div>
                      </div>
                      <Icon name="chevron" className="h-4 w-4 shrink-0 text-slate-500" />
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Editable metadata */}
          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Details</div>
            <Field label="Title">
              <input className={inputCls} value={form.title} onChange={(e) => set("title", e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Author">
                <input className={inputCls} value={form.author ?? ""} onChange={(e) => set("author", e.target.value)} />
              </Field>
              <Field label="Series">
                <input className={inputCls} value={form.series ?? ""} onChange={(e) => set("series", e.target.value)} />
              </Field>
            </div>
            <Field label="Category / shelf">
              <CategoryPicker
                value={form.category ?? ""}
                options={categoryOptions}
                onChange={(v) => set("category", v)}
              />
            </Field>
            <Field label="Subjects / genres">
              <input className={inputCls} value={form.subjects ?? ""} onChange={(e) => set("subjects", e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Publisher">
                <input className={inputCls} value={form.publisher ?? ""} onChange={(e) => set("publisher", e.target.value)} />
              </Field>
              <Field label="Published">
                <input className={inputCls} value={form.published_date ?? ""} onChange={(e) => set("published_date", e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Language">
                <input className={inputCls} value={form.language ?? ""} onChange={(e) => set("language", e.target.value)} />
              </Field>
              <Field label="Pages">
                <input
                  type="number"
                  className={inputCls}
                  value={form.pages ?? ""}
                  onChange={(e) => set("pages", e.target.value ? parseInt(e.target.value) : null)}
                />
              </Field>
              <Field label="Words">
                <input
                  type="number"
                  className={inputCls}
                  value={form.words ?? ""}
                  onChange={(e) => set("words", e.target.value ? parseInt(e.target.value) : null)}
                />
              </Field>
            </div>
            <Field label="ISBN">
              <input className={inputCls} value={form.isbn ?? ""} onChange={(e) => set("isbn", e.target.value)} />
            </Field>
            <Field label="Description">
              <textarea
                className={cx(inputCls, "min-h-24 resize-y leading-relaxed")}
                value={form.description ?? ""}
                onChange={(e) => set("description", e.target.value)}
              />
            </Field>

            <div className="flex items-center gap-2 pt-1">
              <Button variant="primary" busy={savingEdit} onClick={saveEdit} disabled={!dirty || !form.title.trim()}>
                {!savingEdit && <Icon name="check" className="h-4 w-4" />} Save changes
              </Button>
              {book.words_estimated && (
                <span className="text-[11px] text-slate-500">Word count is estimated</span>
              )}
            </div>
          </div>

          {/* File actions */}
          <div className="flex items-center justify-between border-t border-white/10 pt-4">
            <Button variant="subtle" onClick={openFile}>
              <Icon name="open" className="h-4 w-4" /> Show file
            </Button>
            <Button variant="danger" onClick={del}>
              <Icon name="trash" className="h-4 w-4" /> Remove
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProgressControl({ book, onSet }: { book: Book; onSet: (page: number) => void }) {
  const [page, setPage] = useState(book.current_page);
  useEffect(() => setPage(book.current_page), [book.current_page, book.id]);
  const pages = book.pages ?? 0;
  const pct = pages > 0 ? Math.min(100, Math.round((page / pages) * 100)) : book.status === "finished" ? 100 : 0;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-semibold uppercase tracking-wide text-slate-500">Progress</span>
        <span className="tabular-nums text-slate-400">
          {pages > 0 ? `page ${page.toLocaleString()} / ${pages.toLocaleString()} · ${pct}%` : `${pct}%`}
        </span>
      </div>
      {pages > 0 ? (
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={pages}
            value={Math.min(page, pages)}
            onChange={(e) => setPage(parseInt(e.target.value))}
            onMouseUp={() => onSet(page)}
            onTouchEnd={() => onSet(page)}
            className="flex-1 accent-teal-500"
          />
          <input
            type="number"
            min={0}
            max={pages}
            value={page}
            onChange={(e) => setPage(parseInt(e.target.value) || 0)}
            onBlur={() => onSet(page)}
            className="w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm outline-none focus:border-teal-500/50"
          />
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          No page count yet — add one in Details (or fetch metadata) to track page progress. Use the status
          buttons above to mark this book read.
        </p>
      )}
    </div>
  );
}

/** Dropdown of in-use + popular categories, with a "Custom…" free-text escape. */
function CategoryPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const inList = value !== "" && options.some((o) => o.toLowerCase() === value.toLowerCase());
  const [custom, setCustom] = useState(value !== "" && !inList);
  useEffect(() => {
    setCustom(value !== "" && !inList);
  }, [value, inList]);

  const selectValue = custom ? "__custom__" : inList ? value : "";

  return (
    <div className="space-y-2">
      <div className="relative">
        <select
          className={cx(inputCls, "appearance-none pr-9")}
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom__") {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(v);
            }
          }}
        >
          <option value="">— None —</option>
          <optgroup label="Categories">
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </optgroup>
          <option value="__custom__">Custom…</option>
        </select>
        <Icon
          name="chevron"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-slate-500"
        />
      </div>
      {custom && (
        <input
          className={inputCls}
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type a category…"
        />
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-teal-500/50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function toEdit(b: Book): BookEdit {
  return {
    title: b.title,
    author: b.author,
    series: b.series,
    publisher: b.publisher,
    published_date: b.published_date,
    language: b.language,
    isbn: b.isbn,
    description: b.description,
    category: b.category,
    subjects: b.subjects,
    pages: b.pages,
    words: b.words,
  };
}

/** Trim strings and turn empty ones into null before sending to the backend. */
function normalize(e: BookEdit): BookEdit {
  const s = (v: string | null) => {
    const t = (v ?? "").trim();
    return t ? t : null;
  };
  return {
    title: e.title.trim(),
    author: s(e.author),
    series: s(e.series),
    publisher: s(e.publisher),
    published_date: s(e.published_date),
    language: s(e.language),
    isbn: s(e.isbn),
    description: s(e.description),
    category: s(e.category),
    subjects: s(e.subjects),
    pages: e.pages && e.pages > 0 ? e.pages : null,
    words: e.words && e.words > 0 ? e.words : null,
  };
}
