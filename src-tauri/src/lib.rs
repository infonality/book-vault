//! Book Vault — personal ebook library & reading tracker. Rust core entry point:
//! wires up SQLite state, the HTTP client, and the Tauri command surface.

mod commands;
mod covers;
mod db;
mod error;
mod formats;
mod metadata;
mod models;
mod pdfcover;
mod scanner;

use std::sync::Mutex;
use std::time::Duration;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Library DB + cover cache live in the platform app-data dir.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("library.db");
            let conn = db::open(&db_path)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

            let covers_dir = data_dir.join("covers");
            std::fs::create_dir_all(&covers_dir).ok();

            // In release bundles the per-OS PDFium library ships in the resource
            // dir; point the renderer at it (dev falls back to the working dir).
            if let Ok(resource_dir) = app.path().resource_dir() {
                pdfcover::set_search_dir(resource_dir);
            }

            let http = reqwest::Client::builder()
                .user_agent("BookVault/0.1 (personal library manager)")
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

            app.manage(AppState {
                conn: Mutex::new(conn),
                http,
                covers_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::list_books,
            commands::get_book,
            commands::list_categories,
            commands::dashboard_stats,
            commands::scan_library,
            commands::update_book,
            commands::set_status,
            commands::set_progress,
            commands::set_rating,
            commands::delete_book,
            commands::search_metadata,
            commands::apply_metadata,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
