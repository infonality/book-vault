import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, Book, Chapter, Locator, ReaderSession } from "../api";
import { cx, Icon, Spinner } from "../ui";

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

/** Page margin inside the paper, and the gutter between the two columns. */
const PAD = 56;
/** Width past which a second column reads better than one long line. */
const IDEAL_COLUMN = 720;
/** A wheel notch shouldn't fire more than one page turn. */
const WHEEL_COOLDOWN = 320;

type Menu = { x: number; y: number; selection: string } | null;

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
  const [tocOpen, setTocOpen] = useState(false);
  const [menu, setMenu] = useState<Menu>(null);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // Where to land once the next chapter lays out: a ratio through the chapter,
  // or "end" when paging backwards into it.
  const pending = useRef<number | "end" | null>(null);
  const lastWheel = useRef(0);

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

  const charsBefore = useMemo(() => {
    const out: number[] = [];
    let sum = 0;
    for (const s of session?.spine ?? []) {
      out.push(sum);
      sum += s.chars;
    }
    return out;
  }, [session]);

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

    const style = doc.getElementById("bv-layout") ?? doc.createElement("style");
    style.id = "bv-layout";
    style.textContent = `
      html { margin:0; padding:0; height:${h}px; overflow:hidden; }
      body {
        margin:0;
        padding:${PAD}px ${PAD}px ${PAD * 0.75}px;
        height:${h}px;
        box-sizing:border-box;
        column-count:${cols};
        column-gap:${PAD * 1.8}px;
        column-fill:auto;
        -webkit-column-count:${cols};
        -webkit-column-gap:${PAD * 1.8}px;
        text-align:justify;
        hyphens:auto;
        -webkit-hyphens:auto;
      }
      img, svg, video, table { max-width:100%; max-height:${h - PAD * 2}px; height:auto; }
      h1, h2, h3, h4 { break-after:avoid; text-align:left; hyphens:none; }
      a { text-decoration:none; border-bottom:1px solid rgba(0,0,0,.25); }
      ::selection { background:rgba(120,110,255,.28); }
    `;
    if (!style.parentNode) doc.head.appendChild(style);

    const total = Math.max(1, Math.round(doc.body.scrollWidth / w));
    setPages(total);

    let target = page;
    if (pending.current !== null) {
      target = pending.current === "end" ? total - 1 : Math.round(pending.current * total);
      pending.current = null;
    }
    target = Math.min(Math.max(0, target), total - 1);
    setPage(target);
    doc.documentElement.scrollLeft = target * w;
  }, [page]);

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
        setMenu({
          x: rect.left + (e as MouseEvent).clientX,
          y: rect.top + (e as MouseEvent).clientY,
          selection: doc.getSelection()?.toString().trim() ?? "",
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
      setTocOpen(false);
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

  const chapterLabel = useMemo(() => {
    if (!session || !chapter) return "";
    const hit = [...session.toc]
      .filter((t) => t.spine_index !== null && t.spine_index <= chapter.index)
      .pop();
    return hit?.label ?? `Section ${chapter.index + 1}`;
  }, [session, chapter]);

  const cols = (hostRef.current?.clientWidth ?? 0) >= IDEAL_COLUMN * 2 ? 2 : 1;

  return (
    <div
      className="flex h-full flex-col bg-[#2a2622] text-slate-200"
      onClick={() => setMenu(null)}
    >
      {/* Chrome */}
      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
        {onClose && (
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={() => setTocOpen((v) => !v)}
          title="Contents"
          className={cx(
            "rounded-md p-2 transition-colors",
            tocOpen ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10 hover:text-white"
          )}
        >
          <Icon name="list" className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-[13px] font-medium text-white/80">{book.title}</div>
          <div className="truncate text-[11px] text-white/35">{chapterLabel}</div>
        </div>
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
        {tocOpen && (
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

        {/* The paper */}
        <div className="relative min-w-0 flex-1 px-6 pb-3">
          <div
            ref={hostRef}
            className="relative h-full w-full overflow-hidden rounded-md bg-[#faf7f1] shadow-[0_10px_40px_rgba(0,0,0,.45)]"
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

      {menu && (
        <ContextMenu
          menu={menu}
          hasToc={!!session?.toc.length}
          onCopy={() => navigator.clipboard.writeText(menu.selection).catch(() => {})}
          onContents={() => setTocOpen(true)}
          onTurn={turn}
          onExternal={onOpenExternally}
          onDismiss={() => setMenu(null)}
        />
      )}
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
  onDismiss,
}: {
  menu: NonNullable<Menu>;
  hasToc: boolean;
  onCopy: () => void;
  onContents: () => void;
  onTurn: (d: 1 | -1) => void;
  onExternal?: () => void;
  onDismiss: () => void;
}) {
  const items: { label: string; icon: string; run: () => void; show: boolean }[] = [
    { label: "Copy", icon: "check", run: onCopy, show: !!menu.selection },
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
    body { color:#1c1a17; background:#faf7f1; line-height:1.62; font-size:19px;
           font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
           -webkit-font-smoothing:antialiased; }
    p { margin:0 0 0.2em; text-indent:1.3em; }
    p:first-of-type, h1 + p, h2 + p, h3 + p, blockquote p { text-indent:0; }
    h1,h2,h3 { font-weight:600; letter-spacing:-0.01em; }
    blockquote { margin:1em 1.5em; font-style:italic; }
  `;
  doc.head.insertBefore(defaults, baseEl.nextSibling);

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
