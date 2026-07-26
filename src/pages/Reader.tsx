import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Annotation,
  api,
  Book,
  Chapter,
  Locator,
  ReaderSession,
  SearchHit,
} from "../api";
import {
  clearMarks,
  HIGHLIGHT_COLORS,
  markRange,
  offsetsForOccurrence,
  offsetsForSelection,
  pageForRange,
  rangeForOffsets,
} from "../reader-dom";
import { cx, Icon, Spinner } from "../ui";
import { IS_MAC, TRAFFIC_LIGHT_INSET } from "../platform";
import {
  DEFAULT_PREFS,
  FONT_LABELS,
  FONT_STACKS,
  FontChoice,
  loadPrefs,
  ReaderPrefs,
  savePrefs,
  Theme,
  THEMES,
} from "../reader-prefs";

/**
 * Paginated EPUB reader, modelled on the presentation Books uses on macOS:
 * a warm paper page inset from the window, generous margins, a two-page
 * spread with a spine gutter on wide windows, and chrome that stays out of
 * the way until you reach for it.
 *
 * Chapter markup renders inside an iframe sandboxed *without* `allow-scripts`,
 * so nothing in the book can execute — an EPUB is untrusted HTML from wherever
 * the file came from. `allow-same-origin` is what lets this component reach in
 * to lay out columns and measure pages; granting script permission alongside it
 * would undo the protection entirely, so don't.
 */

/** Width past which a second column reads better than one long line. */
const IDEAL_COLUMN = 720;
/** A wheel notch shouldn't fire more than one page turn. */
const WHEEL_COOLDOWN = 320;

type Menu = {
  x: number;
  y: number;
  selection: string;
  /** Offsets of the selection, when there is one. */
  range: { start: number; end: number } | null;
} | null;

type Panel = "toc" | "search" | "notes" | null;

export default function Reader({
  book,
  onClose,
  onProgress,
  onOpenExternally,
}: {
  book: Book;
  onClose?: () => void;
  onProgress?: (b: Book) => void;
  onOpenExternally?: () => void;
}) {
  const [session, setSession] = useState<ReaderSession | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [panel, setPanel] = useState<Panel>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // The search result to keep flagged. It persists across relayouts — marks are
  // cleared and redrawn every paginate, so consuming it on the first pass would
  // make the flag vanish as soon as fonts settled and triggered a second one.
  const flash = useRef<{ text: string; occurrence: number } | null>(null);
  // Set once per jump, to move the page to wherever the match landed.
  const jumpToFlash = useRef(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // Where to land once the next chapter lays out: a ratio through the chapter,
  // or "end" when paging backwards into it.
  const pending = useRef<number | "end" | null>(null);
  const lastWheel = useRef(0);
  // paginate() reads these; depending on them directly would relayout on every
  // annotation change even when nothing visual moved.
  const annotationsRef = useRef<Annotation[]>([]);
  const chapterRef = useRef<number | null>(null);

  // ---- load ----
  useEffect(() => {
    let alive = true;
    api
      .readerOpen(book.id)
      .then((s) => {
        if (!alive) return;
        setSession(s);
        let start = 0;
        if (s.locator) {
          try {
            const loc = JSON.parse(s.locator) as Locator;
            start = Math.min(Math.max(0, loc.spine), s.spine.length - 1);
            pending.current = loc.ratio;
          } catch {
            /* a corrupt locator just means starting from the beginning */
          }
        }
        return api.readerChapter(book.id, start).then((c) => alive && setChapter(c));
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [book.id]);

  const reloadAnnotations = useCallback(() => {
    api.listAnnotations(book.id).then(setAnnotations).catch(() => {});
  }, [book.id]);

  useEffect(reloadAnnotations, [reloadAnnotations]);

  const charsBefore = useMemo(() => {
    const out: number[] = [];
    let sum = 0;
    for (const s of session?.spine ?? []) {
      out.push(sum);
      sum += s.chars;
    }
    return out;
  }, [session]);

  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);
  useEffect(() => {
    chapterRef.current = chapter?.index ?? null;
  }, [chapter]);

  const percentAt = useCallback(
    (spine: number, ratio: number) => {
      if (!session || session.total_chars === 0) return 0;
      const before = charsBefore[spine] ?? 0;
      const within = (session.spine[spine]?.chars ?? 0) * ratio;
      return Math.min(1, (before + within) / session.total_chars);
    },
    [session, charsBefore]
  );

  // ---- lay out into columns ----
  const paginate = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    const host = hostRef.current;
    if (!frame || !doc?.body || !host) return;

    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) return;

    const cols = Math.max(1, Math.min(2, Math.floor(w / IDEAL_COLUMN)));
    const pad = prefs.margin;
    const t = THEMES[prefs.theme];

    // Sepia and night have to force colours, because a publisher stylesheet
    // that sets dark text would be unreadable on a dark page. Paper leaves
    // their colours alone so the book looks as designed.
    const recolour =
      prefs.theme === "paper"
        ? ""
        : `body, body * { color:${t.fg} !important; background-color:transparent !important;
             border-color:rgba(128,128,128,.35) !important; }
           a, a * { color:${t.link} !important; }
           img, svg, video { filter:${prefs.theme === "night" ? "brightness(.82)" : "none"}; }`;

    // Only override the typeface when the reader has actually chosen one;
    // "publisher" leaves the book's own @font-face and families in charge.
    const family =
      prefs.font === "publisher"
        ? ""
        : `body, body * { font-family:${FONT_STACKS[prefs.font]} !important; }`;

    const style = doc.getElementById("bv-layout") ?? doc.createElement("style");
    style.id = "bv-layout";
    style.textContent = `
      html { margin:0; padding:0; height:${h}px; overflow:hidden; background:${t.bg}; }
      body {
        margin:0;
        padding:${pad}px ${pad}px ${pad * 0.75}px;
        height:${h}px;
        box-sizing:border-box;
        column-count:${cols};
        column-gap:${pad * 1.8}px;
        column-fill:auto;
        -webkit-column-count:${cols};
        -webkit-column-gap:${pad * 1.8}px;
        text-align:${prefs.justify ? "justify" : "left"};
        hyphens:${prefs.justify ? "auto" : "manual"};
        -webkit-hyphens:${prefs.justify ? "auto" : "manual"};
        background:${t.bg};
        font-size:${prefs.size}px;
        line-height:${prefs.lineHeight};
      }
      ${family}
      ${recolour}
      img, svg, video, table { max-width:100%; max-height:${h - pad * 2}px; height:auto; }
      h1, h2, h3, h4 { break-after:avoid; text-align:left; hyphens:none; }
      a { text-decoration:none; border-bottom:1px solid currentColor; }
      ::selection { background:rgba(120,110,255,.28); }
    `;
    if (!style.parentNode) doc.head.appendChild(style);

    const total = Math.max(1, Math.round(doc.body.scrollWidth / w));
    setPages(total);

    // Highlights are redrawn from scratch each layout: marks split text nodes,
    // so leaving old ones in place would corrupt subsequent offsets.
    clearMarks(doc, "data-bv-hl");
    clearMarks(doc, "data-bv-seek");
    if (chapterRef.current !== null) {
      for (const a of annotationsRef.current) {
        if (a.spine !== chapterRef.current || a.kind !== "highlight") continue;
        const r = rangeForOffsets(doc, a.start_off, a.end_off);
        if (r) markRange(doc, r, "data-bv-hl", String(a.id), HIGHLIGHT_COLORS[a.color] ?? HIGHLIGHT_COLORS.yellow);
      }
    }

    let target = page;

    // Redraw the search flag every layout, and on a fresh jump move to it.
    if (flash.current) {
      const found = offsetsForOccurrence(doc, flash.current.text, flash.current.occurrence);
      const r = found && rangeForOffsets(doc, found.start, found.end);
      if (r) {
        markRange(doc, r, "data-bv-seek", "1", "rgba(255,193,7,.5)");
        if (jumpToFlash.current) {
          jumpToFlash.current = false;
          pending.current = null;
          const total0 = Math.max(1, Math.round(doc.body.scrollWidth / w));
          setPages(total0);
          const p = Math.min(pageForRange(doc, r, w), total0 - 1);
          setPage(p);
          doc.documentElement.scrollLeft = p * w;
          return;
        }
      } else if (jumpToFlash.current) {
        // The phrase didn't survive markup stripping identically; fall back to
        // the chapter start rather than jumping somewhere arbitrary.
        jumpToFlash.current = false;
        flash.current = null;
      }
    }

    if (pending.current !== null) {
      target = pending.current === "end" ? total - 1 : Math.round(pending.current * total);
      pending.current = null;
    }
    target = Math.min(Math.max(0, target), total - 1);
    setPage(target);
    doc.documentElement.scrollLeft = target * w;
  }, [page, prefs]);

  // ---- wire the frame per chapter ----
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !chapter || !session) return;

    const onLoad = () => {
      const doc = frame.contentDocument;
      if (!doc) return;

      // Links jump within the book rather than navigating the frame away.
      doc.addEventListener("click", (e) => {
        const a = (e.target as HTMLElement)?.closest?.("a");
        if (a) e.preventDefault();
        setMenu(null);
      });

      // Our own menu, not WebView2's reload/inspect one.
      doc.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const rect = frame.getBoundingClientRect();
        const sel = offsetsForSelection(doc);
        setMenu({
          x: rect.left + (e as MouseEvent).clientX,
          y: rect.top + (e as MouseEvent).clientY,
          selection: sel?.text.trim() ?? "",
          range: sel ? { start: sel.start, end: sel.end } : null,
        });
      });

      // Wheel and keys have to be bound on the frame's own document: once it
      // has focus the parent window stops seeing those events. They go through
      // refs because this handler runs once per chapter, while `turn` changes
      // on every page.
      doc.addEventListener(
        "wheel",
        (e) => {
          const we = e as WheelEvent;
          if (Math.abs(we.deltaY) < 4) return;
          const now = Date.now();
          if (now - lastWheel.current < WHEEL_COOLDOWN) return;
          lastWheel.current = now;
          turnRef.current(we.deltaY > 0 ? 1 : -1);
        },
        { passive: true }
      );
      doc.addEventListener("keydown", (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === "Escape") return escapeRef.current();
        if (ke.key === "ArrowRight" || ke.key === "PageDown" || ke.key === " ") {
          ke.preventDefault();
          turnRef.current(1);
        }
        if (ke.key === "ArrowLeft" || ke.key === "PageUp") {
          ke.preventDefault();
          turnRef.current(-1);
        }
      });

      // Fonts change metrics, so re-measure once they've settled.
      (doc as Document & { fonts?: FontFaceSet }).fonts?.ready.then(paginate).catch(() => {});
      paginate();
    };

    frame.addEventListener("load", onLoad);
    frame.srcdoc = buildDocument(chapter, session.resource_base);
    return () => frame.removeEventListener("load", onLoad);
    // `paginate` is excluded on purpose: it changes with `page`, and re-running
    // this would reload the chapter on every page turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter, session]);

  // Redraw marks when an annotation is added or removed.
  useEffect(() => {
    if (chapter) paginate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations]);

  // Changing type or spacing reflows the text, so hold position by ratio.
  useEffect(() => {
    savePrefs(prefs);
    pending.current = pages > 1 ? page / pages : 0;
    paginate();
    // Only prefs should trigger this; page/pages are read, not depended on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      pending.current = pages > 1 ? page / pages : 0;
      paginate();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [paginate, page, pages]);

  // ---- navigation ----
  const goToChapter = useCallback(
    async (index: number, land: number | "end" = 0) => {
      if (!session || index < 0 || index >= session.spine.length) return;
      pending.current = land;
      setPanel(null);
      try {
        setChapter(await api.readerChapter(book.id, index));
      } catch (e) {
        setError(String(e));
      }
    },
    [book.id, session]
  );

  const turn = useCallback(
    (dir: 1 | -1) => {
      const frame = frameRef.current;
      const host = hostRef.current;
      if (!frame?.contentDocument || !host || !chapter) return;
      setMenu(null);
      flash.current = null;
      const next = page + dir;
      if (next < 0) return void goToChapter(chapter.index - 1, "end");
      if (next >= pages) return void goToChapter(chapter.index + 1, 0);
      setPage(next);
      frame.contentDocument.documentElement.scrollLeft = next * host.clientWidth;
    },
    [page, pages, chapter, goToChapter]
  );

  // Latest handlers, reachable from listeners bound once per chapter inside
  // the frame's document.
  const turnRef = useRef(turn);
  const escapeRef = useRef<() => void>(() => {});
  useEffect(() => {
    turnRef.current = turn;
  }, [turn]);
  useEffect(() => {
    escapeRef.current = () => (menu ? setMenu(null) : onClose?.());
  }, [menu, onClose]);

  // Wheel over the chrome (outside the frame) turns pages too.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 4) return;
      const now = Date.now();
      if (now - lastWheel.current < WHEEL_COOLDOWN) return;
      lastWheel.current = now;
      turn(e.deltaY > 0 ? 1 : -1);
    };
    host.addEventListener("wheel", onWheel, { passive: true });
    return () => host.removeEventListener("wheel", onWheel);
  }, [turn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return menu ? setMenu(null) : onClose?.();
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        turn(1);
      }
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        turn(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn, onClose, menu]);

  // ---- persist position ----
  const percent = chapter ? percentAt(chapter.index, pages > 1 ? page / pages : 0) : 0;

  useEffect(() => {
    if (!chapter || !session) return;
    const ratio = pages > 1 ? page / pages : 0;
    const locator: Locator = { spine: chapter.index, ratio };
    const t = setTimeout(() => {
      api
        .readerSavePosition(book.id, JSON.stringify(locator), percentAt(chapter.index, ratio))
        .then((b) => onProgress?.(b))
        .catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [book.id, chapter, page, pages, session, percentAt, onProgress]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    try {
      setHits(await api.readerSearch(book.id, q));
    } catch (e) {
      alert(String(e));
    } finally {
      setSearching(false);
    }
  }, [book.id, query]);

  /** Jump to a result, then locate the exact phrase once the page renders. */
  const gotoHit = useCallback(
    (hit: SearchHit) => {
      flash.current = { text: query.trim(), occurrence: hit.occurrence };
      jumpToFlash.current = true;
      if (chapter?.index === hit.spine) {
        paginate();
      } else {
        goToChapter(hit.spine);
      }
    },
    [query, chapter, paginate, goToChapter]
  );

  const addAnnotation = useCallback(
    async (kind: "highlight" | "bookmark", color = "yellow") => {
      if (!chapter) return;
      const doc = frameRef.current?.contentDocument;
      let range = menu?.range ?? null;
      let text = menu?.selection ?? "";
      // A bookmark with nothing selected marks the top of the current page.
      if (!range && kind === "bookmark" && doc) {
        const chars = chapter.chars || 1;
        const at = Math.round((pages > 1 ? page / pages : 0) * chars);
        range = { start: at, end: at + 1 };
        text = `Page ${page + 1}`;
      }
      if (!range) return;
      try {
        await api.addAnnotation({
          bookId: book.id,
          spine: chapter.index,
          startOff: range.start,
          endOff: range.end,
          kind,
          color,
          text: text.slice(0, 500),
        });
        reloadAnnotations();
      } catch (e) {
        alert(String(e));
      }
      setMenu(null);
    },
    [book.id, chapter, menu, page, pages, reloadAnnotations]
  );

  const removeAnnotation = useCallback(
    async (id: number) => {
      try {
        await api.deleteAnnotation(id);
        reloadAnnotations();
      } catch (e) {
        alert(String(e));
      }
    },
    [reloadAnnotations]
  );

  const chapterLabel = useMemo(
    () => (chapter ? labelForSpine(session, chapter.index) : ""),
    [session, chapter]
  );

  const cols = (hostRef.current?.clientWidth ?? 0) >= IDEAL_COLUMN * 2 ? 2 : 1;

  return (
    <div
      className="relative flex h-full flex-col text-slate-200"
      style={{ background: THEMES[prefs.theme].chrome }}
      onClick={() => {
        setMenu(null);
        setPrefsOpen(false);
      }}
    >
      {/* Chrome */}
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-2 px-3 py-2"
        style={{ paddingLeft: 12 + TRAFFIC_LIGHT_INSET }}
      >
        {/* macOS already provides a close button in the traffic lights. */}
        {onClose && !IS_MAC && (
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={() => setPanel((p) => (p === "toc" ? null : "toc"))}
          title="Contents"
          className={cx(
            "rounded-md p-2 transition-colors",
            panel === "toc" ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10 hover:text-white"
          )}
        >
          <Icon name="list" className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-[13px] font-medium text-white/80">{book.title}</div>
          <div className="truncate text-[11px] text-white/35">{chapterLabel}</div>
        </div>
        <button
          onClick={() => setPanel((p) => (p === "search" ? null : "search"))}
          title="Search in book"
          className={cx(
            "rounded-md p-2 transition-colors",
            panel === "search" ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10 hover:text-white"
          )}
        >
          <Icon name="search" className="h-4 w-4" />
        </button>
        <button
          onClick={() => setPanel((p) => (p === "notes" ? null : "notes"))}
          title="Highlights & bookmarks"
          className={cx(
            "relative rounded-md p-2 transition-colors",
            panel === "notes" ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10 hover:text-white"
          )}
        >
          <Icon name="bookmark" className="h-4 w-4" />
          {annotations.length > 0 && (
            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-teal-400" />
          )}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setPrefsOpen((v) => !v);
          }}
          title="Type and appearance"
          className={cx(
            "rounded-md p-2 transition-colors",
            prefsOpen ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10 hover:text-white"
          )}
        >
          <Icon name="type" className="h-4 w-4" />
        </button>
        {onOpenExternally && (
          <button
            onClick={onOpenExternally}
            title="Open in your system EPUB reader"
            className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <Icon name="open" className="h-4 w-4" />
          </button>
        )}
        <div className="w-12 shrink-0 text-right text-[11px] tabular-nums text-white/40">
          {Math.round(percent * 100)}%
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {panel === "toc" && (
          <nav className="w-72 shrink-0 overflow-y-auto border-r border-white/10 py-2">
            {session?.toc.length ? (
              session.toc.map((t, i) => (
                <button
                  key={i}
                  disabled={t.spine_index === null}
                  onClick={() => t.spine_index !== null && goToChapter(t.spine_index)}
                  style={{ paddingLeft: 14 + t.depth * 14 }}
                  className={cx(
                    "block w-full truncate py-1.5 pr-3 text-left text-[13px] transition-colors",
                    t.spine_index === chapter?.index
                      ? "bg-white/15 text-white"
                      : "text-white/45 hover:bg-white/5 hover:text-white/80",
                    t.spine_index === null && "opacity-40"
                  )}
                  title={t.label}
                >
                  {t.label}
                </button>
              ))
            ) : (
              <p className="px-4 py-2 text-xs text-white/35">No contents in this book.</p>
            )}
          </nav>
        )}

        {panel === "search" && (
          <aside className="flex w-80 shrink-0 flex-col border-r border-white/10">
            <div className="p-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
                placeholder="Search this book…"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-teal-500/50"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {searching ? (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-white/40">
                  <Spinner className="h-3.5 w-3.5" /> Searching…
                </div>
              ) : hits === null ? (
                <p className="px-3 py-2 text-[11px] leading-relaxed text-white/30">
                  Searches the whole book. Press Enter to run.
                </p>
              ) : hits.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-white/30">No matches.</p>
              ) : (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-white/25">
                    {hits.length} match{hits.length === 1 ? "" : "es"}
                  </div>
                  {hits.map((h, i) => (
                    <button
                      key={i}
                      onClick={() => gotoHit(h)}
                      className="block w-full border-b border-white/5 px-3 py-2 text-left transition-colors hover:bg-white/5"
                    >
                      <div className="text-[10px] uppercase tracking-wide text-white/25">
                        {labelForSpine(session, h.spine)}
                      </div>
                      <div className="mt-0.5 line-clamp-3 text-[12px] leading-snug text-white/60">
                        {h.snippet}
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          </aside>
        )}

        {panel === "notes" && (
          <aside className="w-80 shrink-0 overflow-y-auto border-r border-white/10">
            {annotations.length === 0 ? (
              <p className="px-3 py-3 text-[11px] leading-relaxed text-white/30">
                Select text and right-click to highlight it. Bookmarks work the same way,
                or mark the current page from the menu with nothing selected.
              </p>
            ) : (
              annotations.map((a) => (
                <div key={a.id} className="group border-b border-white/5 px-3 py-2">
                  <div className="flex items-start gap-2">
                    <span
                      className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        background:
                          a.kind === "bookmark"
                            ? "rgba(255,255,255,.35)"
                            : HIGHLIGHT_COLORS[a.color] ?? HIGHLIGHT_COLORS.yellow,
                      }}
                    />
                    <button
                      onClick={() => {
                        flash.current = null;
                        goToChapter(a.spine, 0);
                        setTimeout(() => {
                          const doc = frameRef.current?.contentDocument;
                          const host = hostRef.current;
                          if (!doc || !host) return;
                          const r = rangeForOffsets(doc, a.start_off, a.end_off);
                          if (r) {
                            const p = pageForRange(doc, r, host.clientWidth);
                            setPage(p);
                            doc.documentElement.scrollLeft = p * host.clientWidth;
                          }
                        }, 350);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="text-[10px] uppercase tracking-wide text-white/25">
                        {labelForSpine(session, a.spine)}
                      </div>
                      <div className="mt-0.5 line-clamp-3 text-[12px] leading-snug text-white/60">
                        {a.text || "(no text)"}
                      </div>
                    </button>
                    <button
                      onClick={() => removeAnnotation(a.id)}
                      title="Delete"
                      className="rounded p-1 text-white/20 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100"
                    >
                      <Icon name="trash" className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </aside>
        )}

        {/* The paper */}
        <div className="relative min-w-0 flex-1 px-6 pb-3">
          <div
            ref={hostRef}
            className="relative h-full w-full overflow-hidden rounded-md shadow-[0_10px_40px_rgba(0,0,0,.45)]"
            style={{ background: THEMES[prefs.theme].bg }}
          >
            {error ? (
              <div className="grid h-full place-items-center p-8">
                <div className="max-w-md text-center">
                  <Icon name="warning" className="mx-auto h-8 w-8 text-amber-600" />
                  <p className="mt-3 text-sm text-slate-700">{error}</p>
                </div>
              </div>
            ) : !chapter ? (
              <div className="grid h-full place-items-center text-slate-400">
                <Spinner className="h-6 w-6" />
              </div>
            ) : (
              <>
                <iframe
                  ref={frameRef}
                  title={book.title}
                  // No `allow-scripts`: nothing in the book may execute.
                  sandbox="allow-same-origin"
                  className="h-full w-full border-0"
                />
                {/* Spine between the two pages of a spread. */}
                {cols === 2 && (
                  <div className="pointer-events-none absolute inset-y-8 left-1/2 w-px -translate-x-1/2 bg-black/[0.07]" />
                )}
              </>
            )}

            <button
              onClick={() => turn(-1)}
              aria-label="Previous page"
              className="absolute inset-y-0 left-0 w-[12%] cursor-w-resize opacity-0"
            />
            <button
              onClick={() => turn(1)}
              aria-label="Next page"
              className="absolute inset-y-0 right-0 w-[12%] cursor-e-resize opacity-0"
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="flex shrink-0 items-center gap-3 px-6 pb-2 pt-1">
        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-white/40 transition-all"
            style={{ width: `${percent * 100}%` }}
          />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-white/35">
          {page + 1} of {pages}
        </span>
      </footer>

      {prefsOpen && (
        <PrefsPanel prefs={prefs} onChange={setPrefs} onClose={() => setPrefsOpen(false)} />
      )}

      {menu && (
        <ContextMenu
          menu={menu}
          hasToc={!!session?.toc.length}
          onCopy={() => navigator.clipboard.writeText(menu.selection).catch(() => {})}
          onContents={() => setPanel("toc")}
          onTurn={turn}
          onExternal={onOpenExternally}
          onHighlight={(c) => addAnnotation("highlight", c)}
          onBookmark={() => addAnnotation("bookmark")}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** Nearest table-of-contents label at or before a spine index. */
function labelForSpine(session: ReaderSession | null, spine: number): string {
  if (!session) return `Section ${spine + 1}`;
  const hit = [...session.toc]
    .filter((t) => t.spine_index !== null && t.spine_index <= spine)
    .pop();
  return hit?.label ?? `Section ${spine + 1}`;
}

/** Type and appearance, in the spirit of Books' "Aa" popover. */
function PrefsPanel({
  prefs,
  onChange,
  onClose,
}: {
  prefs: ReaderPrefs;
  onChange: (p: ReaderPrefs) => void;
  onClose: () => void;
}) {
  const set = <K extends keyof ReaderPrefs>(k: K, v: ReaderPrefs[K]) =>
    onChange({ ...prefs, [k]: v });

  const themes: { id: Theme; label: string }[] = [
    { id: "paper", label: "Paper" },
    { id: "sepia", label: "Sepia" },
    { id: "night", label: "Night" },
  ];

  return (
    <div
      className="absolute right-3 top-12 z-40 w-72 rounded-xl border border-white/10 bg-slate-900/95 p-3 shadow-2xl backdrop-blur"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Type &amp; appearance
        </span>
        <button
          onClick={onClose}
          className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-white"
        >
          <Icon name="x" className="h-3 w-3" />
        </button>
      </div>

      {/* Theme */}
      <div className="mb-3 grid grid-cols-3 gap-1.5">
        {themes.map((t) => (
          <button
            key={t.id}
            onClick={() => set("theme", t.id)}
            className={cx(
              "rounded-lg border py-2 text-[11px] font-medium transition-colors",
              prefs.theme === t.id ? "border-teal-500/70" : "border-white/10 hover:border-white/25"
            )}
            style={{ background: THEMES[t.id].bg, color: THEMES[t.id].fg }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Typeface — "Publisher's font" is the Original equivalent. */}
      <label className="mb-1 block text-[11px] text-slate-500">Typeface</label>
      <select
        value={prefs.font}
        onChange={(e) => set("font", e.target.value as FontChoice)}
        className="mb-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-sm outline-none focus:border-teal-500/50"
      >
        {(Object.keys(FONT_LABELS) as FontChoice[]).map((f) => (
          <option key={f} value={f}>
            {FONT_LABELS[f]}
          </option>
        ))}
      </select>
      <p className="mb-3 text-[10px] leading-snug text-slate-500">
        {prefs.font === "publisher"
          ? "Using the book's own typeface and embedded fonts."
          : "Overriding the publisher's typeface."}
      </p>

      <Stepper
        label="Text size"
        value={`${prefs.size}px`}
        onDown={() => set("size", Math.max(13, prefs.size - 1))}
        onUp={() => set("size", Math.min(32, prefs.size + 1))}
      />
      <Stepper
        label="Line spacing"
        value={prefs.lineHeight.toFixed(2)}
        onDown={() => set("lineHeight", Math.max(1.2, +(prefs.lineHeight - 0.1).toFixed(2)))}
        onUp={() => set("lineHeight", Math.min(2.4, +(prefs.lineHeight + 0.1).toFixed(2)))}
      />
      <Stepper
        label="Margins"
        value={`${prefs.margin}px`}
        onDown={() => set("margin", Math.max(16, prefs.margin - 8))}
        onUp={() => set("margin", Math.min(140, prefs.margin + 8))}
      />

      <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-slate-300">
        <input
          type="checkbox"
          checked={prefs.justify}
          onChange={(e) => set("justify", e.target.checked)}
          className="accent-teal-500"
        />
        Justify text
      </label>

      <button
        onClick={() => onChange(DEFAULT_PREFS)}
        className="mt-3 w-full rounded-lg border border-white/10 py-1.5 text-[11px] text-slate-400 hover:bg-white/5 hover:text-white"
      >
        Reset to defaults
      </button>
    </div>
  );
}

function Stepper({
  label,
  value,
  onDown,
  onUp,
}: {
  label: string;
  value: string;
  onDown: () => void;
  onUp: () => void;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="flex-1 text-[12px] text-slate-400">{label}</span>
      <span className="w-12 text-right text-[11px] tabular-nums text-slate-500">{value}</span>
      <button
        onClick={onDown}
        className="rounded-md border border-white/10 px-2 py-1 text-slate-300 hover:bg-white/10"
      >
        −
      </button>
      <button
        onClick={onUp}
        className="rounded-md border border-white/10 px-2 py-1 text-slate-300 hover:bg-white/10"
      >
        +
      </button>
    </div>
  );
}

/** Replaces the WebView2 reload/inspect menu with reader actions. */
function ContextMenu({
  menu,
  hasToc,
  onCopy,
  onContents,
  onTurn,
  onExternal,
  onHighlight,
  onBookmark,
  onDismiss,
}: {
  menu: NonNullable<Menu>;
  hasToc: boolean;
  onCopy: () => void;
  onContents: () => void;
  onTurn: (d: 1 | -1) => void;
  onExternal?: () => void;
  onHighlight: (color: string) => void;
  onBookmark: () => void;
  onDismiss: () => void;
}) {
  const items: { label: string; icon: string; run: () => void; show: boolean }[] = [
    { label: "Copy", icon: "check", run: onCopy, show: !!menu.selection },
    {
      label: menu.selection ? "Bookmark this passage" : "Bookmark this page",
      icon: "bookmark",
      run: onBookmark,
      show: true,
    },
    { label: "Next page", icon: "chevron", run: () => onTurn(1), show: true },
    { label: "Previous page", icon: "chevron", run: () => onTurn(-1), show: true },
    { label: "Contents", icon: "list", run: onContents, show: hasToc },
    {
      label: "Open in system reader",
      icon: "open",
      run: () => onExternal?.(),
      show: !!onExternal,
    },
  ].filter((i) => i.show);

  return (
    <div
      className="fixed z-50 min-w-52 overflow-hidden rounded-lg border border-white/10 bg-slate-900/95 py-1 shadow-2xl backdrop-blur"
      style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 200) }}
      onClick={(e) => e.stopPropagation()}
    >
      {menu.selection && (
        <div className="truncate border-b border-white/10 px-3 py-1.5 text-[11px] italic text-slate-500">
          “{menu.selection.slice(0, 40)}
          {menu.selection.length > 40 ? "…" : ""}”
        </div>
      )}
      {menu.range && (
        <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2">
          <span className="mr-auto text-[11px] text-slate-500">Highlight</span>
          {Object.entries(HIGHLIGHT_COLORS).map(([name, css]) => (
            <button
              key={name}
              title={name}
              onClick={() => {
                onHighlight(name);
                onDismiss();
              }}
              className="h-5 w-5 rounded-full border border-white/20 transition-transform hover:scale-110"
              style={{ background: css }}
            />
          ))}
        </div>
      )}
      {items.map((i) => (
        <button
          key={i.label}
          onClick={() => {
            i.run();
            onDismiss();
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <Icon
            name={i.icon}
            className={cx("h-3.5 w-3.5 opacity-60", i.label === "Previous page" && "rotate-180")}
          />
          {i.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Wrap chapter markup for the frame. A `<base>` pointed at the chapter's folder
 * inside the archive makes every relative URL the publisher wrote — images,
 * stylesheets, `@font-face` sources — resolve through the resource protocol
 * untouched, which is what keeps the original typography intact.
 */
function buildDocument(chapter: Chapter, resourceBase: string): string {
  const base = `${resourceBase}${chapter.dir ? `${chapter.dir}/` : ""}`;
  const doc = new DOMParser().parseFromString(chapter.html, "text/html");

  const baseEl = doc.createElement("base");
  baseEl.setAttribute("href", base);
  doc.head.insertBefore(baseEl, doc.head.firstChild);

  // Defaults the publisher's own stylesheet can still override, since these
  // come first in the cascade.
  const defaults = doc.createElement("style");
  defaults.textContent = `
    body { font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
           -webkit-font-smoothing:antialiased; }
    p { margin:0 0 0.2em; text-indent:1.3em; }
    p:first-of-type, h1 + p, h2 + p, h3 + p, blockquote p { text-indent:0; }
    h1,h2,h3 { font-weight:600; letter-spacing:-0.01em; }
    blockquote { margin:1em 1.5em; font-style:italic; }
  `;
  doc.head.insertBefore(defaults, baseEl.nextSibling);

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
