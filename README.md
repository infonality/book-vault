# Book Vault

A personal ebook library and reading tracker, built with **Tauri 2** (Rust core + React/TypeScript UI). Point it at a folder of books and it indexes them, extracts metadata, tracks your reading progress and ratings, and shows a dashboard of what you've read.

Sibling project to Retro Vault — same architecture, applied to books instead of ROMs.

## Features

- **Library scan** — point at a folder; it walks it (subfolders included) and indexes every `.epub`, `.pdf`, `.mobi`, `.azw`, and `.azw3`.
- **Metadata extraction** — pulls title, author, publisher, subjects, ISBN, description, cover art, page count, and word count straight from each file:
  - **EPUB** — full OPF/Dublin-Core metadata, real word count measured from the text, embedded cover.
  - **PDF** — Info dictionary (title/author/keywords) and real page count; word count estimated from pages. The first page is rendered to a cover image via PDFium.
  - **MOBI / AZW** — title, author, publisher, ISBN, subjects from the EXTH header; size metrics estimated.
- **Online metadata** — from a book's detail panel, search **Open Library** (free, no API key) for a richer match: cover, page count, subjects, description. Pick from candidates, or if nothing matches, just type the details in and save.
  - _Note:_ Goodreads retired its public API in 2020, so Open Library stands in as the fetch source.
- **Reading tracker** — a sortable table of every book with status (unread / reading / finished), a progress bar, page position, and a 1–5 star ranking. Categorize books onto shelves.
- **Dashboard** — books read, pages read, words read (summed from finished books), currently-reading list, a by-category breakdown, and recently-finished covers.

## How metrics are counted

- **Pages read / words read** on the dashboard sum the `pages` / `words` of every book marked **finished**.
- EPUB word counts are exact. PDF and MOBI word counts are estimated (see _Words per page_ in Settings) and shown with a `~`. Every value is editable in a book's detail panel.

## Running it

Prerequisites: Node.js and the Rust toolchain (with the Tauri 2 system dependencies).

PDF cover rendering needs the **PDFium** shared library, which is platform-specific and kept out of git. Drop the right one into `src-tauri/` before building (CI does this automatically per-OS):

| OS | File | Source asset ([bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries)) |
| --- | --- | --- |
| Windows | `src-tauri/pdfium.dll` | `pdfium-win-x64.tgz` → `bin/pdfium.dll` |
| macOS | `src-tauri/libpdfium.dylib` | `pdfium-mac-univ.tgz` → `lib/libpdfium.dylib` |
| Linux | `src-tauri/libpdfium.so` | `pdfium-linux-x64.tgz` → `lib/libpdfium.so` |

If the library is missing, the app still runs — PDF covers just fall back to a placeholder.

```bash
npm install
npm run tauri dev
```

To build a distributable bundle for the current OS:

```bash
npm run tauri build
```

The library database and cached cover images live in the platform app-data directory (`library.db` + `covers/`).

## Releases (Windows, macOS, Linux)

Tauri can't cross-compile, so multi-platform installers are built in CI. The
[`release.yml`](.github/workflows/release.yml) workflow builds native installers
on Windows, macOS, and Linux runners (fetching the right PDFium library for each)
and attaches them to a **draft** GitHub Release. Cut a release by pushing a tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Artifacts produced: `.msi` + NSIS `.exe` (Windows), `.dmg` (macOS universal),
`.deb` / `.rpm` / `.AppImage` (Linux). Review the draft Release, then publish.

## Trying it out

A tiny sample book (`sample_books/The Time Machine.epub`) is included. Set your books folder to `sample_books/` in Settings, then click **Scan Books**. Regenerate it with:

```bash
cd src-tauri && cargo run --example make_sample
```

## Project layout

```
src/                     React UI
  api.ts                 typed wrappers over the Tauri command surface
  ui.tsx                 shared primitives (icons, buttons, star rating)
  pages/                 Dashboard, Library (table + detail drawer), Settings
src-tauri/src/
  commands.rs            Tauri IPC boundary
  db.rs                  SQLite schema + queries
  scanner.rs             folder walk + registration
  formats/               epub / pdf / mobi metadata extraction
  metadata.rs            Open Library search + cover download
  covers.rs              cover-image cache
```

## Tests

```bash
cd src-tauri && cargo test
```

## License

[MIT](LICENSE) © Kas
