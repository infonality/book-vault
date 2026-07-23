//! First-page cover rendering for PDFs via PDFium.
//!
//! PDFs carry no cover image, so we rasterise page 1 to a PNG. This needs the
//! PDFium dynamic library (`pdfium.dll` on Windows) next to the executable (or,
//! in dev, in the `src-tauri` working directory). The binding is attempted once
//! per thread and cached; if PDFium can't be found, rendering degrades to a
//! no-op and books simply keep the placeholder cover.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use once_cell::sync::OnceCell;
use pdfium_render::prelude::*;

// Cached per-thread binding. Outer Option = "have we tried to bind yet";
// inner Option = the bound library, or None if binding failed.
thread_local! {
    static PDFIUM: RefCell<Option<Option<Pdfium>>> = const { RefCell::new(None) };
}

// Extra directory to search for the PDFium library, set at startup to the
// bundle's resource dir (where the per-OS library ships in release builds).
static SEARCH_DIR: OnceCell<PathBuf> = OnceCell::new();

/// Register an additional directory to look for the PDFium library in.
pub fn set_search_dir(dir: PathBuf) {
    let _ = SEARCH_DIR.set(dir);
}

/// Render the first page of `pdf_path` to `covers/{book_id}.png` and return its
/// path. Errors (including PDFium being unavailable) leave no file behind.
pub fn render_cover(pdf_path: &Path, covers_dir: &Path, book_id: i64) -> Result<String> {
    let out = covers_dir.join(format!("{book_id}.png"));
    crate::covers::remove_all(covers_dir, book_id);
    with_pdfium(|pdfium| {
        let document = pdfium.load_pdf_from_file(pdf_path, None)?;
        let page = document.pages().get(0)?;
        let config = PdfRenderConfig::new()
            .set_target_width(500)
            .set_maximum_height(760);
        let image = page.render_with_config(&config)?.as_image();
        image
            .into_rgb8()
            .save(&out)
            .map_err(|e| anyhow!("save cover: {e}"))?;
        Ok(())
    })?;
    Ok(out.to_string_lossy().to_string())
}

/// Run `f` with a bound PDFium instance, binding (and caching) on first use.
fn with_pdfium<T>(f: impl FnOnce(&Pdfium) -> Result<T>) -> Result<T> {
    PDFIUM.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(bind());
        }
        match slot.as_ref().and_then(|o| o.as_ref()) {
            Some(pdfium) => f(pdfium),
            None => Err(anyhow!("PDFium library (pdfium.dll) not found")),
        }
    })
}

fn bind() -> Option<Pdfium> {
    for dir in candidate_dirs() {
        let name = Pdfium::pdfium_platform_library_name_at_path(&dir);
        if let Ok(bindings) = Pdfium::bind_to_library(&name) {
            return Some(Pdfium::new(bindings));
        }
    }
    // Fall back to a system-installed PDFium if present.
    Pdfium::bind_to_system_library().ok().map(Pdfium::new)
}

/// Directories to probe for the PDFium library: the registered resource dir
/// (release bundles), next to the executable, and the current working directory
/// (`src-tauri` under `tauri dev`).
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = SEARCH_DIR.get() {
        dirs.push(dir.clone());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    dirs.push(PathBuf::from("."));
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Object, Stream};

    /// Build a valid one-page (200x300) PDF at a temp path.
    fn build_pdf() -> PathBuf {
        let path = std::env::temp_dir().join(format!("bookvault_test_{}.pdf", std::process::id()));
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
            "Contents" => content_id,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc.save(&path).unwrap();
        path
    }

    #[test]
    fn renders_pdf_first_page() {
        // Requires pdfium.dll in the working dir (present in src-tauri). If the
        // library can't be bound, skip rather than fail.
        if PDFIUM.with(|c| {
            let mut s = c.borrow_mut();
            if s.is_none() {
                *s = Some(bind());
            }
            s.as_ref().and_then(|o| o.as_ref()).is_none()
        }) {
            eprintln!("pdfium.dll unavailable, skipping render test");
            return;
        }

        let pdf = build_pdf();
        let dir = std::env::temp_dir();
        let cover = render_cover(&pdf, &dir, 987654).expect("render cover");
        std::fs::remove_file(&pdf).ok();

        let img = image::open(&cover).expect("open rendered png");
        std::fs::remove_file(&cover).ok();
        assert_eq!(img.width(), 500, "cover should render at target width");
        assert!(img.height() > 300, "portrait page should be taller than wide");
    }
}
