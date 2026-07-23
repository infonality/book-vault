import { useEffect, useState } from "react";
import { api, pickFolder, Settings } from "../api";
import { Button, Icon } from "../ui";

export default function SettingsPage({
  settings,
  onSaved,
}: {
  settings: Settings | null;
  onSaved: () => Promise<void> | void;
}) {
  const [booksRoot, setBooksRoot] = useState("");
  const [wpp, setWpp] = useState(275);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setBooksRoot(settings.books_root ?? "");
      setWpp(settings.words_per_page || 275);
    }
  }, [settings]);

  async function browse() {
    const dir = await pickFolder("Choose your books folder");
    if (dir) setBooksRoot(dir);
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await api.saveSettings({ books_root: booksRoot.trim(), words_per_page: Math.max(1, wpp || 275) });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      alert(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-slate-400">Where your books live and how metrics are estimated.</p>
      </header>

      <section className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-5">
        <div>
          <label className="mb-1.5 block text-sm font-medium">Books folder</label>
          <p className="mb-2 text-xs text-slate-500">
            The folder to scan for EPUB, PDF, and MOBI/AZW files (subfolders included).
          </p>
          <div className="flex gap-2">
            <input
              value={booksRoot}
              onChange={(e) => setBooksRoot(e.target.value)}
              placeholder="e.g. C:\Users\you\Books"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-teal-500/50"
            />
            <Button variant="subtle" onClick={browse}>
              <Icon name="folder" className="h-4 w-4" /> Browse
            </Button>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Words per page (estimate)</label>
          <p className="mb-2 text-xs text-slate-500">
            Used to estimate word counts for PDFs and Kindle files, which don't report a real count.
            EPUB word counts are measured directly from the text.
          </p>
          <input
            type="number"
            min={1}
            value={wpp}
            onChange={(e) => setWpp(parseInt(e.target.value) || 0)}
            className="w-32 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-teal-500/50"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button variant="primary" busy={saving} onClick={save} disabled={!booksRoot.trim()}>
            {!saving && <Icon name="check" className="h-4 w-4" />} Save
          </Button>
          {saved && <span className="text-sm text-emerald-400">Saved</span>}
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5 text-sm text-slate-400">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-300">
          <Icon name="sparkles" className="h-4 w-4 text-teal-400" /> About metadata
        </h2>
        <p className="leading-relaxed">
          Book Vault first reads metadata embedded in each file. From a book's detail panel you can also
          fetch richer data (cover, page count, subjects, description) from{" "}
          <span className="text-slate-200">Open Library</span> — a free, open catalogue. Goodreads shut its
          public API in 2020, so Open Library stands in for it. If nothing matches, just type the details in
          yourself and save.
        </p>
      </section>
    </div>
  );
}
