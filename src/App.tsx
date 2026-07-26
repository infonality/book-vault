import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./index.css";
import { api, assetUrl, Book, formatDuration, ProgressEvent, Settings } from "./api";
import { Button, cx, Icon, Logo, Spinner } from "./ui";
import Dashboard from "./pages/Dashboard";
import Library from "./pages/Library";
import Settings_ from "./pages/Settings";

export type View = "dashboard" | "library" | "settings";

// Don't ask where someone got to if they bounced straight back — they probably
// opened the wrong book, or the reader failed to take focus at all.
const MIN_SESSION_MS = 15_000;

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "library", label: "Library", icon: "books" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [checkIn, setCheckIn] = useState<Book | null>(null);
  const pendingRead = useRef<{ book: Book; at: number; blurred: boolean } | null>(null);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  const loadSettings = useCallback(async () => {
    const s = await api.getSettings();
    setSettings(s);
    return s;
  }, []);

  useEffect(() => {
    loadSettings().then((s) => {
      if (!s.books_root) setView("settings");
    });
  }, [loadSettings]);

  // Global progress listener for the scan job.
  useEffect(() => {
    const handle = (p: ProgressEvent) => {
      setProgress(p);
      if (p.done) {
        reload();
        setTimeout(() => setProgress((cur) => (cur?.done ? null : cur)), 3000);
      }
    };
    const a = listen<ProgressEvent>("scan-progress", (e) => handle(e.payload));
    return () => {
      a.then((f) => f());
    };
  }, [reload]);

  // Launch a book in whatever reader the OS uses for that file type, and note
  // that a reading session just started.
  const openBook = useCallback(async (book: Book): Promise<Book> => {
    const updated = await api.openBook(book.id);
    pendingRead.current = { book: updated, at: Date.now(), blurred: false };
    return updated;
  }, []);

  // External readers can't report a page position back to us, so the next best
  // thing is to ask the moment the user returns to the app.
  useEffect(() => {
    const un = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      const p = pendingRead.current;
      if (!p) return;
      if (!focused) {
        p.blurred = true;
        return;
      }
      // Only count it as a real trip away: focus must have actually left, and
      // enough time must have passed to have read something.
      if (p.blurred && Date.now() - p.at > MIN_SESSION_MS) {
        pendingRead.current = null;
        setCheckIn(p.book);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const configured = !!settings?.books_root;

  const doScan = useCallback(async () => {
    setScanning(true);
    try {
      await api.scanLibrary();
    } catch (e) {
      alert(String(e));
    } finally {
      setScanning(false);
      reload();
    }
  }, [reload]);

  return (
    <div className="flex h-full w-full text-slate-200">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/5 bg-black/20 backdrop-blur">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <Logo className="h-9 w-9 shrink-0 rounded-lg shadow-lg shadow-violet-950/40" />
          <div>
            <div className="text-sm font-semibold leading-tight">Book Vault</div>
            <div className="text-[11px] text-slate-500">Reading tracker</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={cx(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                view === n.id
                  ? "bg-teal-600/20 text-white ring-1 ring-inset ring-teal-500/30"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
              )}
            >
              <Icon name={n.icon} className="h-[18px] w-[18px]" />
              {n.label}
            </button>
          ))}
        </nav>

        <div className="px-3 pb-4">
          <Button
            variant="primary"
            className="w-full justify-center"
            busy={scanning}
            onClick={doScan}
            disabled={!configured}
          >
            {!scanning && <Icon name="scan" className="h-4 w-4" />}
            {scanning ? "Scanning…" : "Scan Books"}
          </Button>
          {!configured && (
            <p className="mt-2 px-1 text-[11px] leading-snug text-slate-500">
              Set your books folder in Settings to get started.
            </p>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="relative flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">
          {view === "dashboard" && (
            <Dashboard
              reloadToken={reloadToken}
              goto={setView}
              onScan={doScan}
              scanning={scanning}
              configured={configured}
            />
          )}
          {view === "library" && (
            <Library reloadToken={reloadToken} onReload={reload} onOpen={openBook} />
          )}
          {view === "settings" && (
            <Settings_
              settings={settings}
              onSaved={async () => {
                await loadSettings();
                reload();
              }}
            />
          )}
        </div>
      </main>

      {/* Corner stack: reading check-in + scan progress */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-3">
        {checkIn && (
          <CheckInPrompt
            key={checkIn.id}
            book={checkIn}
            onClose={() => setCheckIn(null)}
            onSaved={() => {
              setCheckIn(null);
              reload();
            }}
          />
        )}
        {progress && <ProgressToast p={progress} />}
      </div>
    </div>
  );
}

/** Asks how far the user got after they come back from an external reader. */
function CheckInPrompt({
  book,
  onClose,
  onSaved,
}: {
  book: Book;
  onClose: () => void;
  onSaved: () => void;
}) {
  const pages = book.pages ?? 0;
  const [page, setPage] = useState(book.current_page);
  const [busy, setBusy] = useState(false);
  const img = assetUrl(book.cover_path);
  const away = book.last_opened_at ? Math.floor(Date.now() / 1000) - book.last_opened_at : 0;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onSaved();
    } catch (e) {
      alert(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="bv-fade pointer-events-auto rounded-xl border border-white/10 bg-slate-900/95 p-4 shadow-2xl backdrop-blur">
      <div className="flex items-start gap-3">
        <div className="h-14 w-10 shrink-0 overflow-hidden rounded bg-slate-800">
          {img ? (
            <img src={img} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-slate-600">
              <Icon name="book" className="h-4 w-4" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{book.title}</div>
          <div className="text-[11px] text-slate-500">
            Read for {formatDuration(away)} — how far did you get?
          </div>
        </div>
        <button
          onClick={onClose}
          className="-mt-1 rounded-lg p-1.5 text-slate-500 hover:bg-white/10 hover:text-white"
          title="Not now"
        >
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>

      {pages > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={pages}
            value={page}
            autoFocus
            onChange={(e) => setPage(parseInt(e.target.value) || 0)}
            onKeyDown={(e) => e.key === "Enter" && !busy && run(() => api.setProgress(book.id, page))}
            className="w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm tabular-nums outline-none focus:border-teal-500/50"
          />
          <span className="text-xs text-slate-500">of {pages.toLocaleString()}</span>
          <Button
            variant="primary"
            className="ml-auto"
            busy={busy}
            disabled={page === book.current_page}
            onClick={() => run(() => api.setProgress(book.id, page))}
          >
            Save
          </Button>
        </div>
      )}

      <button
        disabled={busy}
        onClick={() => run(() => api.setStatus(book.id, "finished"))}
        className="mt-2 w-full rounded-lg border border-white/10 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
      >
        I finished it
      </button>
    </div>
  );
}

function ProgressToast({ p }: { p: ProgressEvent }) {
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : p.done ? 100 : 0;
  return (
    <div className="bv-fade pointer-events-auto rounded-xl border border-white/10 bg-slate-900/90 p-4 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center gap-2">
        {p.done ? (
          <Icon name="check" className="h-4 w-4 text-emerald-400" />
        ) : (
          <Spinner className="h-4 w-4 text-teal-400" />
        )}
        <span className="text-sm font-medium capitalize">{p.job}</span>
        {p.total > 0 && (
          <span className="ml-auto text-xs text-slate-400">
            {p.current}/{p.total}
          </span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={cx("h-full rounded-full transition-all", p.done ? "bg-emerald-500" : "bg-teal-500")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 truncate text-xs text-slate-400">{p.message}</p>
    </div>
  );
}
