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
  const [comicsRoot, setComicsRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      setBooksRoot(settings.books_root ?? "");
      setComicsRoot(settings.comics_root ?? "");
    }
  }, [settings]);

  async function browse() {
    const dir = await pickFolder("Choose your books folder");
    if (dir) setBooksRoot(dir);
  }

  async function browseComics() {
    const dir = await pickFolder("Choose your comics folder");
    if (dir) setComicsRoot(dir);
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await api.saveSettings({
        books_root: booksRoot.trim(),
        comics_root: comicsRoot.trim(),
        // Still stored: it's what turns an EPUB's word count into a page
        // estimate, since EPUBs have no pages of their own.
        words_per_page: settings?.words_per_page || 275,
      });
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
        <p className="mt-1 text-sm text-slate-400">
          Where your books and comics live.
        </p>
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
          <label className="mb-1.5 block text-sm font-medium">Comics folder</label>
          <p className="mb-2 text-xs text-slate-500">
            Scanned for CBZ, CBR and PDF. Comics need their own folder because the file type
            can't tell them apart from books — plenty of comics are PDFs, so whichever folder a
            file sits in decides where it lands.
          </p>
          <div className="flex gap-2">
            <input
              value={comicsRoot}
              onChange={(e) => setComicsRoot(e.target.value)}
              placeholder="e.g. C:\Users\you\Comics"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-teal-500/50"
            />
            <Button variant="subtle" onClick={browseComics}>
              <Icon name="folder" className="h-4 w-4" /> Browse
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="primary"
            busy={saving}
            onClick={save}
            disabled={!booksRoot.trim() && !comicsRoot.trim()}
          >
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
          Shelfmark first reads metadata embedded in each file. From a book's detail panel you can also
          fetch richer data (cover, page count, subjects, description) from{" "}
          <span className="text-slate-200">Open Library</span> — a free, open catalogue. Goodreads shut its
          public API in 2020, so Open Library stands in for it. If nothing matches, just type the details in
          yourself and save.
        </p>
      </section>
    </div>
  );
}
