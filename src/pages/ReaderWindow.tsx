import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, Book } from "../api";
import { Icon, Spinner } from "../ui";
import Reader from "./Reader";
import ComicReader from "./ComicReader";
import PdfReader from "./PdfReader";
import "../index.css";

/**
 * Host for a standalone reader window. The library spawns one of these per
 * book with `?book=<id>`, so reading has its own window, its own taskbar entry,
 * and can sit alongside the library rather than covering it.
 *
 * Which reader appears is decided here rather than by the caller: a comic and a
 * book open the same way and differ only in what draws the page.
 */
export default function ReaderWindow({ bookId }: { bookId: number }) {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getBook(bookId)
      .then((b) => (b ? setBook(b) : setError("That book is no longer in your library.")))
      .catch((e) => setError(String(e)));
  }, [bookId]);

  // Keep the window title in step with what's open.
  useEffect(() => {
    if (book) getCurrentWindow().setTitle(book.title).catch(() => {});
  }, [book]);

  const close = useCallback(() => {
    getCurrentWindow().close().catch(() => {});
  }, []);

  const openExternally = useCallback(() => {
    api.openBook(bookId).catch((e) => alert(String(e)));
  }, [bookId]);

  // The reader supplies its own menu; suppress WebView2's outside the frame too.
  useEffect(() => {
    const onMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, []);

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-[#2a2622] p-8 text-center">
        <div>
          <Icon name="warning" className="mx-auto h-8 w-8 text-amber-500" />
          <p className="mt-3 text-sm text-slate-300">{error}</p>
        </div>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="grid h-full place-items-center bg-[#2a2622] text-slate-400">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  // A PDF is decided by its format rather than its shelf: both a scanned comic
  // and a technical book arrive as rasterised pages, so they read the same way.
  if (book.format.toLowerCase() === "pdf") {
    return <PdfReader book={book} onClose={close} onOpenExternally={openExternally} />;
  }
  if (book.kind === "comic") {
    return <ComicReader book={book} onClose={close} onOpenExternally={openExternally} />;
  }
  return <Reader book={book} onClose={close} onOpenExternally={openExternally} />;
}
