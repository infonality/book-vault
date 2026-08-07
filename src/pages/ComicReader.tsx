import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, Book, ComicLocator, ComicSession } from "../api";
import { cx, Icon, Spinner } from "../ui";
import { IS_MAC, TRAFFIC_LIGHT_INSET } from "../platform";

/**
 * Paginated comic reader.
 *
 * A comic is far simpler than an EPUB — every page is one image, and nothing
 * reflows — so this has none of the layout machinery of the book reader. What
 * it does have to take seriously is weight: a couple of hundred pages at
 * several hundred kilobytes each is more than a window should ever hold. Pages
 * are fetched as they are reached and the neighbours are warmed in the
 * background, which is what makes a turn land instantly without keeping the
 * issue in memory.
 */

/** How a page is sized against the window. */
type Fit = "page" | "width" | "actual";

const FITS: { id: Fit; label: string; hint: string }[] = [
  { id: "page", label: "Page", hint: "Fit the whole page" },
  { id: "width", label: "Width", hint: "Fill the width and scroll" },
  { id: "actual", label: "1:1", hint: "Actual size" },
];

const FIT_KEY = "bv.comicFit";
/** A wheel gesture shouldn't fire a second turn until it settles. */
const WHEEL_COOLDOWN = 260;
/** How many pages ahead to warm. One back covers a change of mind. */
const AHEAD = 2;

function loadFit(): Fit {
  const saved = localStorage.getItem(FIT_KEY);
  return saved === "width" || saved === "actual" ? saved : "page";
}

/**
 * URL for a page. Each segment is encoded separately so a name with spaces or
 * non-Latin characters survives the trip, while the slashes that separate
 * folders inside the archive stay as slashes.
 */
function pageUrl(session: ComicSession, index: number): string {
  const entry = session.pages[index];
  if (!entry) return "";
  return session.resource_base + entry.split("/").map(encodeURIComponent).join("/");
}

export default function ComicReader({
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
  const [session, setSession] = useState<ComicSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [fit, setFit] = useState<Fit>(loadFit);
  const [loaded, setLoaded] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastWheel = useRef(0);
  const count = session?.pages.length ?? 0;

  // ---- load ----
  useEffect(() => {
    let alive = true;
    api
      .comicOpen(book.id)
      .then((s) => {
        if (!alive) return;
        setSession(s);
        let start = 0;
        if (s.locator) {
          try {
            const loc = JSON.parse(s.locator) as ComicLocator;
            if (Number.isFinite(loc.page)) start = loc.page;
          } catch {
            /* a corrupt locator just means starting at the first page */
          }
        }
        setPage(Math.min(Math.max(0, start), s.pages.length - 1));
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [book.id]);

  useEffect(() => {
    localStorage.setItem(FIT_KEY, fit);
  }, [fit]);

  const src = useMemo(
    () => (session ? pageUrl(session, page) : ""),
    [session, page]
  );

  // A new page starts unloaded, so the spinner shows rather than the previous
  // page lingering under a stale label.
  useEffect(() => {
    setLoaded(false);
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [page]);

  // ---- warm the neighbours ----
  // Decoding a page is the slow part, and the browser will hold these in its
  // own cache (the protocol sends Cache-Control), so a turn is instant.
  useEffect(() => {
    if (!session) return;
    const wanted = [];
    for (let i = 1; i <= AHEAD; i++) wanted.push(page + i);
    wanted.push(page - 1);
    for (const i of wanted) {
      if (i < 0 || i >= session.pages.length) continue;
      const img = new Image();
      img.src = pageUrl(session, i);
    }
  }, [session, page]);

  // ---- navigation ----
  const turn = useCallback(
    (dir: 1 | -1) => {
      setPage((p) => Math.min(Math.max(0, p + dir), Math.max(0, count - 1)));
    },
    [count]
  );

  const goTo = useCallback(
    (n: number) => setPage(Math.min(Math.max(0, n), Math.max(0, count - 1))),
    [count]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      switch (e.key) {
        case "Escape":
          onClose?.();
          break;
        case "ArrowRight":
        case "PageDown":
        case " ":
          e.preventDefault();
          turn(1);
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          turn(-1);
          break;
        case "Home":
          e.preventDefault();
          goTo(0);
          break;
        case "End":
          e.preventDefault();
          goTo(count - 1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn, goTo, count, onClose]);

  /**
   * Wheel behaviour depends on the fit. With the whole page visible there is
   * nothing to scroll, so a notch turns. When the page overflows, scrolling
   * comes first and a turn only happens once you're already at the edge —
   * otherwise a long page would skip past its own bottom half.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 4) return;
      const down = e.deltaY > 0;
      const canScroll = el.scrollHeight > el.clientHeight + 1;
      if (canScroll) {
        const atEnd = down
          ? el.scrollTop + el.clientHeight >= el.scrollHeight - 2
          : el.scrollTop <= 1;
        if (!atEnd) return;
      }
      const now = Date.now();
      if (now - lastWheel.current < WHEEL_COOLDOWN) return;
      lastWheel.current = now;
      turn(down ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, [turn]);

  // ---- persist position ----
  useEffect(() => {
    if (!session || count === 0) return;
    const locator: ComicLocator = { page };
    const t = setTimeout(() => {
      api
        .readerSavePosition(book.id, JSON.stringify(locator), (page + 1) / count)
        .then((b) => onProgress?.(b))
        .catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [book.id, page, count, session, onProgress]);

  const percent = count > 0 ? (page + 1) / count : 0;

  const imgClass =
    fit === "page"
      ? "max-h-full max-w-full object-contain"
      : fit === "width"
        ? "w-full h-auto"
        : "max-w-none";

  return (
    <div className="relative flex h-full flex-col bg-[#0e0e11] text-slate-200">
      {/* Chrome */}
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-2 px-3 py-2"
        style={{ paddingLeft: 12 + TRAFFIC_LIGHT_INSET }}
      >
        {onClose && !IS_MAC && (
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-[13px] font-medium text-white/80">{book.title}</div>
          <div className="truncate text-[11px] text-white/35">
            {count > 0 ? `Page ${page + 1} of ${count}` : "…"}
          </div>
        </div>

        <div className="flex shrink-0 items-center rounded-md border border-white/10 p-0.5">
          {FITS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFit(f.id)}
              title={f.hint}
              className={cx(
                "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                fit === f.id
                  ? "bg-white/15 text-white"
                  : "text-white/45 hover:bg-white/10 hover:text-white"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {onOpenExternally && (
          <button
            onClick={onOpenExternally}
            title="Open in your system comic reader"
            className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <Icon name="open" className="h-4 w-4" />
          </button>
        )}
      </header>

      {/* The page */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className={cx(
            "h-full w-full",
            fit === "page" ? "overflow-hidden" : "overflow-auto",
            fit === "actual" ? "grid place-items-start" : "grid place-items-center"
          )}
        >
          {error ? (
            <div className="grid h-full place-items-center p-8">
              <div className="max-w-md text-center">
                <Icon name="warning" className="mx-auto h-8 w-8 text-amber-500" />
                <p className="mt-3 text-sm text-slate-300">{error}</p>
              </div>
            </div>
          ) : !session ? (
            <div className="grid h-full place-items-center text-slate-500">
              <Spinner className="h-6 w-6" />
            </div>
          ) : (
            <>
              {!loaded && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center text-slate-600">
                  <Spinner className="h-6 w-6" />
                </div>
              )}
              <img
                key={src}
                src={src}
                alt={`Page ${page + 1}`}
                onLoad={() => setLoaded(true)}
                onError={() => setLoaded(true)}
                className={cx(imgClass, "select-none", loaded ? "opacity-100" : "opacity-0")}
                draggable={false}
              />
            </>
          )}
        </div>

        {/* Click zones, wide enough to hit without thinking and invisible so
            they never sit on top of the art. */}
        {session && (
          <>
            <button
              onClick={() => turn(-1)}
              aria-label="Previous page"
              className="absolute inset-y-0 left-0 w-[15%] cursor-w-resize opacity-0"
            />
            <button
              onClick={() => turn(1)}
              aria-label="Next page"
              className="absolute inset-y-0 right-0 w-[15%] cursor-e-resize opacity-0"
            />
          </>
        )}
      </div>

      {/* Footer: a scrubber, because two hundred pages is a long way by arrow key. */}
      <footer className="flex shrink-0 items-center gap-3 px-5 pb-2 pt-1.5">
        <input
          type="range"
          min={0}
          max={Math.max(0, count - 1)}
          value={page}
          onChange={(e) => goTo(Number(e.target.value))}
          disabled={count === 0}
          aria-label="Jump to page"
          className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-white/15 accent-accent-500"
        />
        <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-white/35">
          {count > 0 ? `${Math.round(percent * 100)}%` : ""}
        </span>
      </footer>
    </div>
  );
}
