<p align="center">
  <img src="docs/banner.png" alt="Book Vault — your ebook library, catalogued and tracked" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-a78bfa?style=flat-square" alt="MIT license">
  <img src="https://img.shields.io/badge/platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-a78bfa?style=flat-square" alt="Platforms">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202-a78bfa?style=flat-square" alt="Built with Tauri 2">
  <img src="https://img.shields.io/badge/data-100%25%20local-a78bfa?style=flat-square" alt="100% local">
</p>

Point Book Vault at a folder of ebooks and it builds you a proper library: it reads
the metadata out of each file, fetches cover art and page counts for anything
missing, and then tracks what you've read.

Everything stays on your machine — a single SQLite file and a folder of cached
covers. There's no account, no sync, and no telemetry.

---

## Features

**Scans a folder, understands the files**
Walks a directory (subfolders included) and indexes every `.epub`, `.pdf`,
`.mobi`, `.azw`, and `.azw3`, reading title, author, publisher, subjects, ISBN,
description, page count, and word count out of the file itself.

**Finds covers, even when the file has none**
EPUB and MOBI covers are lifted straight from the file. PDFs don't carry one, so
the first page is rendered into a cover image instead.

**Fills the gaps online**
Anything still missing can be looked up on [Open Library](https://openlibrary.org) —
cover, page count, subjects, description — from a list of candidate matches. No
API key needed. If nothing matches, type the details in yourself.

**Reads your EPUBs**
A built-in reader opens each book in its own window: paginated two-page spread,
table of contents, and your position remembered to the paragraph. Themes for
paper, sepia and night, with adjustable size, spacing and margins — and a
**Publisher's font** option that leaves the book's own typeface and embedded
fonts exactly as designed.

**Search, highlight and bookmark**
Full-text search across the whole book jumps you to the passage and flags it.
Select any text to highlight it in one of four colours, or drop a bookmark;
both are listed in a side panel that takes you back. Highlights are anchored to
the text itself, so changing the type size or resizing the window never moves
them.

**Or hands them to whatever you already use**
PDFs go straight to your system's default application, and EPUBs can too from
the details panel. Book Vault marks the book as started and asks how far you got
when you come back, since an external reader can't report position back.

**Tracks your reading**
A sortable table — or a cover grid — of every book with reading status, progress,
a 1–5 star rating, and free-text categories with a preset picker. Reading an EPUB
in the built-in reader updates progress on its own; nothing to type in.

**Shows you the numbers**
A dashboard totalling books, pages, and words read, what you're part-way through,
and a breakdown by category.

## Install

Grab the installer for your platform from the
[latest release](https://github.com/infonality/book-vault/releases/latest).

| Platform | File |
| --- | --- |
| Windows | `.msi`, or `.exe` (NSIS installer) |
| macOS | `.dmg` (universal — Apple Silicon and Intel) |
| Linux | `.deb`, `.rpm`, or `.AppImage` |

The builds aren't code-signed, so the first launch needs a nudge: on macOS
right-click the app and choose **Open**; on Windows click **More info → Run
anyway**; the AppImage needs `chmod +x` before it will run.

Then open **Settings**, choose the folder your books live in, and hit **Scan
Books**.

## How the metadata works

What can be read from a file varies a lot by format, so Book Vault takes what it
can get and lets you correct the rest — every field stays editable.

| Format | Metadata | Pages | Words | Cover |
| --- | --- | --- | --- | --- |
| EPUB | Full Dublin Core from the OPF | Estimated from word count | **Counted** from the text | Embedded |
| PDF | Info dictionary | **Exact** page count | Estimated from pages | First page, rendered |
| MOBI / AZW | EXTH header | Estimated | Estimated | Embedded when present |

Estimated word counts are shown with a `~` and use a words-per-page figure you
can change in Settings. Pages and words only count toward your totals once a book
is marked finished.

Reflowable text has no fixed pages, so the reader stores your position as a spine
index plus a ratio through that chapter rather than a page number — it survives a
font change, a resize, or a switch to a two-column spread. The percentage you see
is derived from character counts taken when the book opens.

> **On Goodreads:** Goodreads retired its public API in 2020 and issues no new
> keys, so there's no supported way to query it. Open Library is the stand-in —
> it's free, needs no credentials, and covers the same ground.

## Building from source

You'll need [Node.js](https://nodejs.org) and the
[Rust toolchain](https://rustup.rs) with Tauri's
[system dependencies](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev
```

PDF cover rendering needs the **PDFium** shared library, which is
platform-specific and not checked in. Drop the matching file into `src-tauri/`
(CI does this automatically for releases):

| OS | File | Asset from [pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) |
| --- | --- | --- |
| Windows | `src-tauri/pdfium.dll` | `pdfium-win-x64.tgz` → `bin/pdfium.dll` |
| macOS | `src-tauri/libpdfium.dylib` | `pdfium-mac-univ.tgz` → `lib/libpdfium.dylib` |
| Linux | `src-tauri/libpdfium.so` | `pdfium-linux-x64.tgz` → `lib/libpdfium.so` |

Without it the app still runs; PDFs just fall back to a placeholder cover.

To build an installer for your current OS:

```bash
npm run tauri build
```

Want something to test against? `sample_books/` has a generated EPUB and PDF —
point Settings at it and scan. Regenerate them with
`cd src-tauri && cargo run --example make_sample`.

## Releases

Tauri can't cross-compile, so installers are built in CI on native runners for
each OS. Pushing a version tag builds all three and attaches them to a draft
release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

To get installers without cutting a release — for testing on a machine you
don't build on — run the workflow manually from the Actions tab. It builds all
three platforms and attaches them to the run as artifacts instead.

## Project layout

```
src/                    React + TypeScript UI
  api.ts                typed wrappers over the Tauri command surface
  ui.tsx                shared primitives (icons, buttons, star rating)
  reader-prefs.ts       themes, typefaces and spacing for the reader
  pages/                Dashboard, Library (table/grid + drawer), Settings
    Reader.tsx          paginated reader; Books-style presentation
    ReaderWindow.tsx    host for the standalone reader window
src-tauri/src/
  commands.rs           Tauri IPC boundary
  db.rs                 SQLite schema and queries
  scanner.rs            folder walk, registration, cover refresh
  formats/              epub / pdf / mobi metadata extraction
  reader.rs             spine, contents, sanitising, asset serving
  pdfcover.rs           PDF first-page rendering via PDFium
  metadata.rs           Open Library search and cover download
```

Your library lives in the platform app-data directory — `library.db` plus a
`covers/` folder. Book Vault never modifies the ebook files themselves.

## Tests

```bash
cd src-tauri && cargo test
```

## License

[MIT](LICENSE) © Kas
