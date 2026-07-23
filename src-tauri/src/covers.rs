//! Cover-image storage. Covers (extracted from files or downloaded from Open
//! Library) are cached under the app-data `covers/` dir, named by book id, and
//! surfaced to the webview through Tauri's asset protocol.

use std::path::Path;

use anyhow::Result;

/// Cover extensions we may have written for a book.
const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "svg"];

/// Remove any cached cover files for a book (all known extensions).
pub fn remove_all(covers_dir: &Path, book_id: i64) {
    for ext in COVER_EXTS {
        let p = covers_dir.join(format!("{book_id}.{ext}"));
        if p.exists() {
            std::fs::remove_file(&p).ok();
        }
    }
}

/// Write cover bytes as `covers/{book_id}.{ext}`, replacing any existing file.
/// Returns the absolute path as a string for storage in the DB.
pub fn store_bytes(covers_dir: &Path, book_id: i64, bytes: &[u8], ext: &str) -> Result<String> {
    remove_all(covers_dir, book_id);
    let path = covers_dir.join(format!("{book_id}.{ext}"));
    std::fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().to_string())
}
