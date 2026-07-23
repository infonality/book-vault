//! Error helpers.
//!
//! Internally every module uses `anyhow::Result` (so `?` works across rusqlite /
//! reqwest / io / zip / pdf errors). At the Tauri command boundary we convert to
//! `Result<T, String>`, which Tauri serialises to the frontend.

/// Result type returned by Tauri commands.
pub type CmdResult<T> = Result<T, String>;
