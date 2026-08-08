/**
 * Opening a book, from wherever in the app you clicked it.
 *
 * This lives on its own because more than one page opens books, and a copy of
 * the rule in each of them is how the dashboard ended up merely switching to
 * the library instead of opening what you clicked.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Book } from "./api";

/**
 * Whether a built-in reader can show this, or the OS has to.
 *
 * CBR is excluded on purpose and not by oversight: RAR's reference decoder
 * can't be vendored into an MIT project, so the archive is never opened.
 */
export function readsInApp(book: Book): boolean {
  const format = book.format.toLowerCase();
  // A PDF reads in app whichever shelf it is on: a scanned comic and a
  // technical book are the same file format, and the reader rasterises pages
  // either way.
  if (format === "pdf") return true;
  return book.kind === "comic" ? format === "cbz" : format === "epub";
}

/**
 * Open a book in its own reader window, focusing the existing one if it is
 * already up. `onClosed` fires when the window goes away, so the caller can
 * pick up whatever progress was made.
 */
export async function openReaderWindow(book: Book, onClosed?: () => void): Promise<void> {
  const label = `reader-${book.id}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const win = new WebviewWindow(label, {
    url: `index.html?book=${book.id}`,
    title: book.title,
    width: 1100,
    height: 820,
    minWidth: 480,
    minHeight: 420,
    // macOS only; ignored elsewhere. Matches the main window's chrome.
    // Lowercase here: the JS API and the JSON config spell this differently.
    titleBarStyle: "overlay",
    hiddenTitle: true,
  });
  win.once("tauri://error", (e) =>
    alert(`Couldn't open the reader: ${JSON.stringify(e.payload)}`)
  );
  if (onClosed) win.once("tauri://destroyed", () => onClosed());
}
