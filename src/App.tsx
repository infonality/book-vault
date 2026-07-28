import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./index.css";
import { api, Book, ProgressEvent, Settings } from "./api";
import { Button, cx, Icon, Logo, Spinner } from "./ui";
import { TITLE_BAR_HEIGHT } from "./platform";
import Dashboard from "./pages/Dashboard";
import Library from "./pages/Library";
import Settings_ from "./pages/Settings";

export type View = "dashboard" | "library" | "comics" | "settings";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "library", label: "Books", icon: "books" },
  { id: "comics", label: "Comics", icon: "comics" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [scanning, setScanning] = useState(false);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  // WebView2's own menu offers reload and inspect, which mean nothing in a
  // desktop app. Text fields keep theirs, since cut/copy/paste is genuinely
  // useful there.
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, []);

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

  // Launch a book in whatever reader the OS uses for that file type. We don't
  // chase the reader for a position afterwards — an external app can't report
  // one, and interrupting the user to ask was worse than not knowing. Totals
  // move when a book is marked finished instead.
  const openBook = useCallback(async (book: Book): Promise<Book> => {
    return api.openBook(book.id);
  }, []);

  const configured = !!(settings?.books_root || settings?.comics_root);

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
        <div
          data-tauri-drag-region
          className="flex items-center gap-2.5 px-5 py-5"
          style={{ paddingTop: 20 + TITLE_BAR_HEIGHT }}
        >
          <Logo className="h-9 w-9 shrink-0 rounded-lg shadow-lg shadow-violet-950/40" />
          <div>
            <div className="text-sm font-semibold leading-tight">Shelfmark</div>
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
              Set a books or comics folder in Settings to get started.
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
            <Library reloadToken={reloadToken} onReload={reload} onOpen={openBook} kind="book" />
          )}
          {view === "comics" && (
            <Library reloadToken={reloadToken} onReload={reload} onOpen={openBook} kind="comic" />
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

      {/* Scan progress */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-3">
        {progress && <ProgressToast p={progress} />}
      </div>
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
