//! SQLite persistence via rusqlite (bundled). Holds the book library, extracted /
//! fetched metadata, reading state, and app settings. The connection lives behind
//! a Mutex in app state; every function here takes `&Connection`.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::{Annotation, Book, BookEdit, CategoryStat, DashboardStats, Settings};

pub fn open(path: &std::path::Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;",
    )?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS books (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            path           TEXT NOT NULL UNIQUE,
            filename       TEXT NOT NULL,
            format         TEXT NOT NULL,
            size           INTEGER NOT NULL DEFAULT 0,
            title          TEXT NOT NULL DEFAULT '',
            author         TEXT,
            series         TEXT,
            publisher      TEXT,
            published_date TEXT,
            language       TEXT,
            isbn           TEXT,
            description    TEXT,
            category       TEXT,
            subjects       TEXT,
            cover_path     TEXT,
            pages          INTEGER,
            words          INTEGER,
            words_estimated INTEGER NOT NULL DEFAULT 0,
            status         TEXT NOT NULL DEFAULT 'unread',
            current_page   INTEGER NOT NULL DEFAULT 0,
            rating         INTEGER,
            meta_status    TEXT NOT NULL DEFAULT 'none',
            meta_source    TEXT,
            started_at     INTEGER,
            finished_at    INTEGER,
            last_opened_at INTEGER,
            added_at       INTEGER NOT NULL DEFAULT 0,
            updated_at     INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_books_status   ON books(status);
        CREATE INDEX IF NOT EXISTS idx_books_category ON books(category);

        -- Highlights and bookmarks. Anchored by character offsets into the
        -- chapter's rendered text rather than anything geometric, so they
        -- survive a font change, a resize, or a switch to two columns.
        CREATE TABLE IF NOT EXISTS annotations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            spine      INTEGER NOT NULL,
            start_off  INTEGER NOT NULL,
            end_off    INTEGER NOT NULL,
            -- highlight | bookmark
            kind       TEXT NOT NULL DEFAULT 'highlight',
            color      TEXT NOT NULL DEFAULT 'yellow',
            text       TEXT NOT NULL DEFAULT '',
            note       TEXT,
            created_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_annotations_book
            ON annotations(book_id, spine, start_off);
        "#,
    )?;
    // Columns added after 0.1.1 — existing libraries need them backfilled.
    add_column(conn, "books", "last_opened_at", "INTEGER")?;
    // Reflowable text has no fixed pages, so the built-in reader remembers a
    // position as spine index + character offset rather than a page number.
    add_column(conn, "books", "locator", "TEXT")?;
    // Comics live in their own root and their own section of the UI. A file's
    // format can't decide this on its own — a comic is often a PDF — so the
    // folder it came from does, and this records the answer.
    add_column(conn, "books", "kind", "TEXT NOT NULL DEFAULT 'book'")?;
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_books_kind ON books(kind);")?;
    Ok(())
}

/// `ALTER TABLE ... ADD COLUMN`, but a no-op when the column is already there.
/// SQLite has no `IF NOT EXISTS` for this, so we check the table info first.
fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|c| c.ok())
        .any(|c| c == column);
    drop(stmt);
    if !exists {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    }
    Ok(())
}

// ---------- settings ----------

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let v = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get::<_, String>(0)
        })
        .optional()?;
    Ok(v)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn load_settings(conn: &Connection) -> Result<Settings> {
    let g = |k: &str| get_setting(conn, k).ok().flatten().unwrap_or_default();
    let words_per_page = g("words_per_page").parse::<i64>().unwrap_or(0);
    Ok(Settings {
        books_root: g("books_root"),
        comics_root: g("comics_root"),
        words_per_page: if words_per_page > 0 { words_per_page } else { 275 },
    })
}

pub fn save_settings(conn: &Connection, s: &Settings) -> Result<()> {
    set_setting(conn, "books_root", &s.books_root)?;
    set_setting(conn, "comics_root", &s.comics_root)?;
    let wpp = if s.words_per_page > 0 { s.words_per_page } else { 275 };
    set_setting(conn, "words_per_page", &wpp.to_string())?;
    Ok(())
}

// ---------- books ----------

const BOOK_COLS: &str = "id, path, filename, format, size, title, author, series, publisher,
    published_date, language, isbn, description, category, subjects, cover_path, pages, words,
    words_estimated, status, current_page, rating, meta_status, meta_source, started_at,
    finished_at, last_opened_at, locator, kind, added_at, updated_at";

fn row_to_book(r: &Row) -> rusqlite::Result<Book> {
    Ok(Book {
        id: r.get(0)?,
        path: r.get(1)?,
        filename: r.get(2)?,
        format: r.get(3)?,
        size: r.get(4)?,
        title: r.get(5)?,
        author: r.get(6)?,
        series: r.get(7)?,
        publisher: r.get(8)?,
        published_date: r.get(9)?,
        language: r.get(10)?,
        isbn: r.get(11)?,
        description: r.get(12)?,
        category: r.get(13)?,
        subjects: r.get(14)?,
        cover_path: r.get(15)?,
        pages: r.get(16)?,
        words: r.get(17)?,
        words_estimated: r.get::<_, i64>(18)? != 0,
        status: r.get(19)?,
        current_page: r.get(20)?,
        rating: r.get(21)?,
        meta_status: r.get(22)?,
        meta_source: r.get(23)?,
        started_at: r.get(24)?,
        finished_at: r.get(25)?,
        last_opened_at: r.get(26)?,
        locator: r.get(27)?,
        kind: r.get(28)?,
        added_at: r.get(29)?,
        updated_at: r.get(30)?,
    })
}

/// A freshly-scanned book plus everything extracted from the file itself.
pub struct ScannedBook {
    pub path: String,
    pub filename: String,
    pub format: String,
    pub size: i64,
    pub title: String,
    pub author: Option<String>,
    pub series: Option<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub subjects: Option<String>,
    pub cover_path: Option<String>,
    pub pages: Option<i64>,
    pub words: Option<i64>,
    pub words_estimated: bool,
    /// "embedded" if the file carried a title, otherwise "none".
    pub meta_status: String,
    /// book | comic
    pub kind: String,
}

/// Insert a newly-scanned book. If the path already exists, refresh only the
/// file-derived fields, preserving any user edits / fetched metadata / reading
/// state. Returns (id, inserted).
pub fn upsert_scanned(conn: &Connection, b: &ScannedBook, now: i64) -> Result<(i64, bool)> {
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM books WHERE path = ?1", [&b.path], |r| r.get(0))
        .optional()?;
    if let Some(id) = existing {
        // Keep it simple: only refresh size + filename so the row tracks the file.
        conn.execute(
            "UPDATE books SET filename=?2, size=?3, kind=?4, updated_at=?5 WHERE id=?1",
            params![id, b.filename, b.size, b.kind, now],
        )?;
        Ok((id, false))
    } else {
        conn.execute(
            "INSERT INTO books(
                path, filename, format, size, title, author, series, publisher, published_date,
                language, isbn, description, subjects, cover_path, pages, words,
                words_estimated, meta_status, kind, added_at, updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?20)",
            params![
                b.path, b.filename, b.format, b.size, b.title, b.author, b.series, b.publisher,
                b.published_date, b.language, b.isbn, b.description, b.subjects, b.cover_path,
                b.pages, b.words, b.words_estimated as i64, b.meta_status, b.kind, now
            ],
        )?;
        Ok((conn.last_insert_rowid(), true))
    }
}

/// Delete books whose files are no longer under the scan root. `live_paths` are
/// the paths seen during the current scan.
pub fn delete_missing(conn: &Connection, live_paths: &[String]) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("CREATE TEMP TABLE IF NOT EXISTS live_paths(p TEXT PRIMARY KEY)", [])?;
    tx.execute("DELETE FROM live_paths", [])?;
    {
        let mut stmt = tx.prepare("INSERT OR IGNORE INTO live_paths(p) VALUES(?1)")?;
        for p in live_paths {
            stmt.execute([p])?;
        }
    }
    let removed = tx.execute(
        "DELETE FROM books WHERE path NOT IN (SELECT p FROM live_paths)",
        [],
    )?;
    tx.execute("DELETE FROM live_paths", [])?;
    tx.commit()?;
    Ok(removed)
}

pub fn get_book(conn: &Connection, id: i64) -> Result<Option<Book>> {
    let sql = format!("SELECT {BOOK_COLS} FROM books WHERE id = ?1");
    let b = conn.query_row(&sql, [id], row_to_book).optional()?;
    Ok(b)
}

pub fn list_books(conn: &Connection) -> Result<Vec<Book>> {
    let sql = format!("SELECT {BOOK_COLS} FROM books ORDER BY title COLLATE NOCASE");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], row_to_book)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Distinct non-empty categories currently in use.
pub fn list_categories(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT category FROM books
         WHERE category IS NOT NULL AND category <> ''
         ORDER BY category COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Apply user-edited bibliographic fields. Marks metadata as manual and, when a
/// page count is present but words are missing, fills a word estimate.
pub fn update_book(conn: &Connection, id: i64, e: &BookEdit, words_per_page: i64, now: i64) -> Result<()> {
    // Derive an estimate only when the user gave pages but left words blank.
    let (words, words_estimated) = match (e.words, e.pages) {
        (Some(w), _) => (Some(w), false),
        (None, Some(p)) if p > 0 => (Some(p * words_per_page.max(1)), true),
        _ => (None, false),
    };
    conn.execute(
        "UPDATE books SET
            title=?2, author=?3, series=?4, publisher=?5, published_date=?6, language=?7,
            isbn=?8, description=?9, category=?10, subjects=?11, pages=?12, words=?13,
            words_estimated=?14, meta_status='manual', updated_at=?15
         WHERE id=?1",
        params![
            id, e.title, e.author, e.series, e.publisher, e.published_date, e.language,
            e.isbn, e.description, e.category, e.subjects, e.pages, words,
            words_estimated as i64, now
        ],
    )?;
    Ok(())
}

/// Set reading status, keeping started/finished timestamps and current_page in
/// sync. Finishing a book snaps current_page to the page count.
pub fn set_status(conn: &Connection, id: i64, status: &str, now: i64) -> Result<()> {
    let book = get_book(conn, id)?.ok_or_else(|| anyhow::anyhow!("Book not found"))?;
    match status {
        "reading" => {
            let started = book.started_at.unwrap_or(now);
            conn.execute(
                "UPDATE books SET status='reading', started_at=?2, finished_at=NULL, updated_at=?3
                 WHERE id=?1",
                params![id, started, now],
            )?;
        }
        "finished" => {
            let started = book.started_at.unwrap_or(now);
            let last_page = book.pages.unwrap_or(book.current_page);
            conn.execute(
                "UPDATE books SET status='finished', started_at=?2, finished_at=?3,
                    current_page=?4, updated_at=?3 WHERE id=?1",
                params![id, started, now, last_page],
            )?;
        }
        _ => {
            // unread
            conn.execute(
                "UPDATE books SET status='unread', started_at=NULL, finished_at=NULL,
                    current_page=0, updated_at=?2 WHERE id=?1",
                params![id, now],
            )?;
        }
    }
    Ok(())
}

/// Update the current page. Automatically flips status to reading (from unread)
/// or finished (when reaching the last page).
pub fn set_progress(conn: &Connection, id: i64, current_page: i64, now: i64) -> Result<()> {
    let book = get_book(conn, id)?.ok_or_else(|| anyhow::anyhow!("Book not found"))?;
    let pages = book.pages.unwrap_or(0);
    let cp = current_page.max(0);
    if pages > 0 && cp >= pages {
        set_status(conn, id, "finished", now)?;
        return Ok(());
    }
    let started = book.started_at.unwrap_or(now);
    let status = if cp > 0 { "reading".to_string() } else { book.status.clone() };
    conn.execute(
        "UPDATE books SET current_page=?2, status=?3, started_at=?4, updated_at=?5 WHERE id=?1",
        params![id, cp, status, started, now],
    )?;
    Ok(())
}

/// Record that the file was just handed to an external reader. Picking a book
/// up counts as starting it, so an unread book flips to reading; a finished one
/// is left alone (re-opening a book you've read shouldn't undo the milestone).
pub fn mark_opened(conn: &Connection, id: i64, now: i64) -> Result<()> {
    let book = get_book(conn, id)?.ok_or_else(|| anyhow::anyhow!("Book not found"))?;
    if book.status == "unread" {
        set_status(conn, id, "reading", now)?;
    }
    // Bumping updated_at as well keeps the most recently picked-up books at the
    // top of the dashboard's "in progress" list.
    conn.execute(
        "UPDATE books SET last_opened_at=?2, updated_at=?2 WHERE id=?1",
        params![id, now],
    )?;
    Ok(())
}

/// Remember where the built-in reader left off. `locator` is opaque JSON so the
/// reader can evolve its position format without another migration; `percent`
/// feeds the existing page-based progress so the dashboard keeps working.
pub fn save_locator(conn: &Connection, id: i64, locator: &str, percent: f64, now: i64) -> Result<()> {
    let book = get_book(conn, id)?.ok_or_else(|| anyhow::anyhow!("Book not found"))?;
    let pages = book.pages.unwrap_or(0);
    let page = if pages > 0 {
        ((percent.clamp(0.0, 1.0) * pages as f64).round() as i64).clamp(0, pages)
    } else {
        book.current_page
    };
    // Reaching the end counts as finishing, matching set_progress's behaviour.
    if pages > 0 && page >= pages {
        conn.execute(
            "UPDATE books SET locator=?2 WHERE id=?1",
            params![id, locator],
        )?;
        return set_status(conn, id, "finished", now);
    }
    let started = book.started_at.unwrap_or(now);
    let status = if book.status == "unread" { "reading" } else { &book.status };
    conn.execute(
        "UPDATE books SET locator=?2, current_page=?3, status=?4, started_at=?5, updated_at=?6
         WHERE id=?1",
        params![id, locator, page, status, started, now],
    )?;
    Ok(())
}

pub fn get_locator(conn: &Connection, id: i64) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT locator FROM books WHERE id=?1", [id], |r| r.get(0))
        .optional()?
        .flatten())
}

pub fn set_rating(conn: &Connection, id: i64, rating: Option<i64>, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE books SET rating=?2, updated_at=?3 WHERE id=?1",
        params![id, rating, now],
    )?;
    Ok(())
}

/// Apply fetched metadata from an Open Library candidate.
#[allow(clippy::too_many_arguments)]
pub fn apply_metadata(
    conn: &Connection,
    id: i64,
    title: &str,
    author: Option<&str>,
    publisher: Option<&str>,
    published_date: Option<&str>,
    isbn: Option<&str>,
    subjects: Option<&str>,
    description: Option<&str>,
    pages: Option<i64>,
    words: Option<i64>,
    words_estimated: bool,
    cover_path: Option<&str>,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE books SET
            title=?2, author=COALESCE(?3, author), publisher=COALESCE(?4, publisher),
            published_date=COALESCE(?5, published_date), isbn=COALESCE(?6, isbn),
            subjects=COALESCE(?7, subjects), description=COALESCE(?8, description),
            pages=COALESCE(?9, pages), words=COALESCE(?10, words),
            words_estimated=?11, cover_path=COALESCE(?12, cover_path),
            meta_status='fetched', meta_source='Open Library', updated_at=?13
         WHERE id=?1",
        params![
            id, title, author, publisher, published_date, isbn, subjects, description,
            pages, words, words_estimated as i64, cover_path, now
        ],
    )?;
    Ok(())
}

// ---------- annotations ----------

fn row_to_annotation(r: &Row) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: r.get(0)?,
        book_id: r.get(1)?,
        spine: r.get(2)?,
        start_off: r.get(3)?,
        end_off: r.get(4)?,
        kind: r.get(5)?,
        color: r.get(6)?,
        text: r.get(7)?,
        note: r.get(8)?,
        created_at: r.get(9)?,
    })
}

const ANNOTATION_COLS: &str =
    "id, book_id, spine, start_off, end_off, kind, color, text, note, created_at";

pub fn list_annotations(conn: &Connection, book_id: i64) -> Result<Vec<Annotation>> {
    let sql = format!(
        "SELECT {ANNOTATION_COLS} FROM annotations WHERE book_id=?1
         ORDER BY spine, start_off"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([book_id], row_to_annotation)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[allow(clippy::too_many_arguments)]
pub fn add_annotation(
    conn: &Connection,
    book_id: i64,
    spine: i64,
    start_off: i64,
    end_off: i64,
    kind: &str,
    color: &str,
    text: &str,
    now: i64,
) -> Result<Annotation> {
    conn.execute(
        "INSERT INTO annotations(book_id, spine, start_off, end_off, kind, color, text, created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![book_id, spine, start_off, end_off, kind, color, text, now],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("SELECT {ANNOTATION_COLS} FROM annotations WHERE id=?1");
    Ok(conn.query_row(&sql, [id], row_to_annotation)?)
}

pub fn update_annotation(
    conn: &Connection,
    id: i64,
    note: Option<&str>,
    color: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE annotations SET note=COALESCE(?2, note), color=COALESCE(?3, color) WHERE id=?1",
        params![id, note, color],
    )?;
    Ok(())
}

pub fn delete_annotation(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM annotations WHERE id=?1", [id])?;
    Ok(())
}

pub fn delete_book(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM books WHERE id=?1", [id])?;
    Ok(())
}

// ---------- dashboard ----------

pub fn dashboard(conn: &Connection) -> Result<DashboardStats> {
    let one = |sql: &str| -> Result<i64> {
        Ok(conn.query_row(sql, [], |r| r.get::<_, i64>(0))?)
    };
    let total_books = one("SELECT COUNT(*) FROM books WHERE kind='book'")?;
    let finished_books = one("SELECT COUNT(*) FROM books WHERE kind='book' AND status='finished'")?;
    let reading_books = one("SELECT COUNT(*) FROM books WHERE kind='book' AND status='reading'")?;
    let unread_books = one("SELECT COUNT(*) FROM books WHERE kind='book' AND status='unread'")?;
    let pages_read =
        one("SELECT COALESCE(SUM(pages),0) FROM books WHERE kind='book' AND status='finished' AND pages IS NOT NULL")?;
    let words_read =
        one("SELECT COALESCE(SUM(words),0) FROM books WHERE kind='book' AND status='finished' AND words IS NOT NULL")?;

    let total_comics = one("SELECT COUNT(*) FROM books WHERE kind='comic'")?;
    let finished_comics =
        one("SELECT COUNT(*) FROM books WHERE kind='comic' AND status='finished'")?;

    let avg_rating: Option<f64> = conn
        .query_row(
            "SELECT AVG(rating) FROM books WHERE rating IS NOT NULL",
            [],
            |r| r.get::<_, Option<f64>>(0),
        )
        .optional()?
        .flatten();

    // Category rollup (books without a category grouped under "Uncategorized").
    let mut stmt = conn.prepare(
        "SELECT COALESCE(NULLIF(category,''), 'Uncategorized') AS cat,
                COUNT(*) AS total,
                SUM(CASE WHEN status='finished' THEN 1 ELSE 0 END) AS finished
         FROM books WHERE kind='book' GROUP BY cat ORDER BY total DESC, cat COLLATE NOCASE",
    )?;
    let categories = stmt
        .query_map([], |r| {
            Ok(CategoryStat {
                name: r.get(0)?,
                total: r.get(1)?,
                finished: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let recent_finished = query_books(
        conn,
        "WHERE kind='book' AND status='finished' ORDER BY finished_at DESC LIMIT 6",
    )?;
    let in_progress = query_books(
        conn,
        "WHERE kind='book' AND status='reading' ORDER BY updated_at DESC LIMIT 8",
    )?;

    Ok(DashboardStats {
        total_books,
        finished_books,
        reading_books,
        unread_books,
        pages_read,
        words_read,
        avg_rating,
        categories,
        recent_finished,
        in_progress,
        total_comics,
        finished_comics,
    })
}

fn query_books(conn: &Connection, tail: &str) -> Result<Vec<Book>> {
    let sql = format!("SELECT {BOOK_COLS} FROM books {tail}");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], row_to_book)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Convenience used by commands after a mutation to hand the fresh row back.
pub fn require_book(conn: &Connection, id: i64) -> Result<Book> {
    get_book(conn, id)?.ok_or_else(|| anyhow::anyhow!("Book not found"))
}
