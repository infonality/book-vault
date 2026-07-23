//! Tauri command surface — the typed IPC boundary the React UI calls into.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, State};

use crate::db;
use crate::error::CmdResult;
use crate::models::{
    Book, BookEdit, DashboardStats, MetaCandidate, ScanResult, Settings,
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
