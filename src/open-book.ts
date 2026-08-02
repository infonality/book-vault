/**
 * Opening a book, from wherever in the app you clicked it.
 *
 * This lives on its own because more than one page opens books, and a copy of
 * the rule in each of them is how the dashboard ended up merely switching to
 * the library instead of opening what you clicked.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Book } from "./api";

/** Whether the built-in reader can show this book, or the OS has to. */
export function readsInApp(book: Book): boolean {
  return book.kind !== "comic" && book.format.toLowerCase() === "epub";
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
