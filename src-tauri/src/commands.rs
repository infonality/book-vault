//! Tauri command surface — the typed IPC boundary the React UI calls into.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, State};

use crate::db;
use crate::error::CmdResult;
use crate::models::{
    Annotation, Book, BookEdit, DashboardStats, MetaCandidate, ScanResult, Settings,
};
use crate::scanner::now_ts;
use crate::{covers, metadata, scanner};

pub struct AppState {
    pub conn: Mutex<Connection>,
    pub http: reqwest::Client,
    pub covers_dir: PathBuf,
}

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------- settings ----------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    let conn = state.conn.lock().map_err(s)?;
    db::load_settings(&conn).map_err(s)
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<()> {
    let conn = state.conn.lock().map_err(s)?;
    db::save_settings(&conn, &settings).map_err(s)
}

// ---------------- library ----------------

#[tauri::command]
pub fn list_books(state: State<'_, AppState>) -> CmdResult<Vec<Book>> {
    let conn = state.conn.lock().map_err(s)?;
    db::list_books(&conn).map_err(s)
}

#[tauri::command]
pub fn get_book(state: State<'_, AppState>, id: i64) -> CmdResult<Option<Book>> {
    let conn = state.conn.lock().map_err(s)?;
    db::get_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn list_categories(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let conn = state.conn.lock().map_err(s)?;
    db::list_categories(&conn).map_err(s)
}

#[tauri::command]
pub fn dashboard_stats(state: State<'_, AppState>) -> CmdResult<DashboardStats> {
    let conn = state.conn.lock().map_err(s)?;
    db::dashboard(&conn).map_err(s)
}

// ---------------- scan ----------------

#[tauri::command]
pub fn scan_library(app: AppHandle, state: State<'_, AppState>) -> CmdResult<ScanResult> {
    let conn = state.conn.lock().map_err(s)?;
    let settings = db::load_settings(&conn).map_err(s)?;
    if settings.books_root.trim().is_empty() {
        return Err("Set your books folder in Settings first.".into());
    }
    let root = PathBuf::from(&settings.books_root);
    scanner::scan(&conn, &root, &state.covers_dir, settings.words_per_page, |ev| {
        let _ = app.emit("scan-progress", ev);
    })
    .map_err(s)
}

// ---------------- edits & reading state ----------------

#[tauri::command]
pub fn update_book(state: State<'_, AppState>, id: i64, edit: BookEdit) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    let settings = db::load_settings(&conn).map_err(s)?;
    db::update_book(&conn, id, &edit, settings.words_per_page, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn set_status(state: State<'_, AppState>, id: i64, status: String) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    db::set_status(&conn, id, &status, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn set_progress(state: State<'_, AppState>, id: i64, current_page: i64) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    db::set_progress(&conn, id, current_page, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn set_rating(state: State<'_, AppState>, id: i64, rating: Option<i64>) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    db::set_rating(&conn, id, rating, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

// ---------------- built-in reader ----------------

/// Everything the reader needs to open a book: reading order, contents, the
/// saved position, and the base URL its frame resolves assets against.
#[derive(serde::Serialize)]
pub struct ReaderSession {
    #[serde(flatten)]
    pub book: crate::reader::ReaderBook,
    pub resource_base: String,
    pub locator: Option<String>,
    pub title: String,
}

/// Base URL of the `epubres` protocol. Tauri maps custom schemes onto an
/// http origin on Windows and Android, and a real scheme elsewhere.
fn resource_base(id: i64) -> String {
    #[cfg(any(windows, target_os = "android"))]
    let base = format!("http://epubres.localhost/{id}/");
    #[cfg(not(any(windows, target_os = "android")))]
    let base = format!("epubres://localhost/{id}/");
    base
}

#[tauri::command]
pub fn reader_open(state: State<'_, AppState>, id: i64) -> CmdResult<ReaderSession> {
    let (path, title, locator) = {
        let conn = state.conn.lock().map_err(s)?;
        let b = db::require_book(&conn, id).map_err(s)?;
        (b.path, b.title, db::get_locator(&conn, id).map_err(s)?)
    };
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("The file is no longer at {path}. Rescan your library."));
    }
    let book = crate::reader::open(std::path::Path::new(&path)).map_err(|e| format!("{e:#}"))?;
    Ok(ReaderSession { book, resource_base: resource_base(id), locator, title })
}

#[tauri::command]
pub fn reader_chapter(
    state: State<'_, AppState>,
    id: i64,
    index: usize,
) -> CmdResult<crate::reader::Chapter> {
    let path = {
        let conn = state.conn.lock().map_err(s)?;
        db::require_book(&conn, id).map_err(s)?.path
    };
    crate::reader::chapter(std::path::Path::new(&path), index).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn reader_save_position(
    state: State<'_, AppState>,
    id: i64,
    locator: String,
    percent: f64,
) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    db::save_locator(&conn, id, &locator, percent, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn reader_search(
    state: State<'_, AppState>,
    id: i64,
    query: String,
) -> CmdResult<Vec<crate::reader::SearchHit>> {
    let path = {
        let conn = state.conn.lock().map_err(s)?;
        db::require_book(&conn, id).map_err(s)?.path
    };
    // Capped so a single-letter query on a long book can't flood the UI.
    crate::reader::search(std::path::Path::new(&path), &query, 300)
        .map_err(|e| format!("{e:#}"))
}

// ---------------- highlights & bookmarks ----------------

#[tauri::command]
pub fn list_annotations(state: State<'_, AppState>, book_id: i64) -> CmdResult<Vec<Annotation>> {
    let conn = state.conn.lock().map_err(s)?;
    db::list_annotations(&conn, book_id).map_err(s)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn add_annotation(
    state: State<'_, AppState>,
    book_id: i64,
    spine: i64,
    start_off: i64,
    end_off: i64,
    kind: String,
    color: String,
    text: String,
) -> CmdResult<Annotation> {
    let conn = state.conn.lock().map_err(s)?;
    db::add_annotation(
        &conn, book_id, spine, start_off, end_off, &kind, &color, &text, now_ts(),
    )
    .map_err(s)
}

#[tauri::command]
pub fn update_annotation(
    state: State<'_, AppState>,
    id: i64,
    note: Option<String>,
    color: Option<String>,
) -> CmdResult<()> {
    let conn = state.conn.lock().map_err(s)?;
    db::update_annotation(&conn, id, note.as_deref(), color.as_deref()).map_err(s)
}

#[tauri::command]
pub fn delete_annotation(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.conn.lock().map_err(s)?;
    db::delete_annotation(&conn, id).map_err(s)
}

/// Hand a book to whatever application the OS has registered for its file type,
/// and record that we did. The path is looked up from the library rather than
/// taken from the caller, so the webview can't ask us to launch arbitrary files.
#[tauri::command]
pub fn open_book(state: State<'_, AppState>, id: i64) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    let book = db::require_book(&conn, id).map_err(s)?;

    let path = PathBuf::from(&book.path);
    if !path.is_file() {
        return Err(format!(
            "The file is no longer at {}. Rescan your library to update it.",
            book.path
        ));
    }

    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| {
        format!("Couldn't open {}: {e}. Is a {} reader installed?", book.filename, book.format)
    })?;

    db::mark_opened(&conn, id, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn delete_book(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.conn.lock().map_err(s)?;
    db::delete_book(&conn, id).map_err(s)?;
    // Drop any cached cover for this book.
    for ext in ["jpg", "png", "gif", "webp", "jpeg", "svg"] {
        let p = state.covers_dir.join(format!("{id}.{ext}"));
        if p.exists() {
            std::fs::remove_file(&p).ok();
        }
    }
    Ok(())
}

// ---------------- online metadata (Open Library) ----------------

#[tauri::command]
pub async fn search_metadata(
    state: State<'_, AppState>,
    query: String,
) -> CmdResult<Vec<MetaCandidate>> {
    let http = state.http.clone();
    metadata::search(&http, &query).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn apply_metadata(
    state: State<'_, AppState>,
    id: i64,
    candidate: MetaCandidate,
) -> CmdResult<Book> {
    // Snapshot what we need under a short lock.
    let (words_per_page, book) = {
        let conn = state.conn.lock().map_err(s)?;
        let settings = db::load_settings(&conn).map_err(s)?;
        let book = db::require_book(&conn, id).map_err(s)?;
        (settings.words_per_page, book)
    };

    let http = state.http.clone();

    // Fill a description only when the book doesn't already have one.
    let description = if book.description.as_deref().map(|d| d.is_empty()).unwrap_or(true) {
        match &candidate.work_key {
            Some(k) => metadata::fetch_description(&http, k).await,
            None => None,
        }
    } else {
        None
    };

    // Download and cache the cover art.
    let cover_path = if let Some(url) = &candidate.cover_url {
        match metadata::download_cover(&http, url).await {
            Ok(bytes) if !bytes.is_empty() => {
                covers::store_bytes(&state.covers_dir, id, &bytes, "jpg").ok()
            }
            _ => None,
        }
    } else {
        None
    };

    // Derive word count from the fetched page count only if we don't already
    // have a real (non-estimated) count.
    let published_date = candidate.year.map(|y| y.to_string());
    let (words, words_estimated) = match candidate.pages {
        Some(p) if p > 0 && (book.words.is_none() || book.words_estimated) => {
            (Some(p * words_per_page.max(1)), true)
        }
        _ => (book.words, book.words_estimated),
    };

    {
        let conn = state.conn.lock().map_err(s)?;
        db::apply_metadata(
            &conn,
            id,
            &candidate.title,
            candidate.author.as_deref(),
            candidate.publisher.as_deref(),
            published_date.as_deref(),
            candidate.isbn.as_deref(),
            candidate.subjects.as_deref(),
            description.as_deref(),
            candidate.pages,
            words,
            words_estimated,
            cover_path.as_deref(),
            now_ts(),
        )
        .map_err(s)?;
        db::require_book(&conn, id).map_err(s)
    }
}
