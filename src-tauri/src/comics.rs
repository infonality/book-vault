//! Built-in comic reader backend.
//!
//! A CBZ is a ZIP of page images, read in filename order — there is no manifest
//! and no reading order to parse, which is why this module is a fraction of the
//! size of the EPUB one. All it has to answer is "which entries are pages, and
//! in what order".
//!
//! The pages themselves are served by the `bookres` protocol, the same one that
//! serves an EPUB's images and stylesheets: it resolves an entry inside a book's
//! own archive and nothing else. Comics are large — a couple of hundred pages of
//! several hundred kilobytes each — so pages are fetched one at a time as they
//! are reached, never extracted up front.
//!
//! CBR is deliberately not supported here for the same reason it isn't
//! catalogued: RAR's reference decoder can't be vendored into an MIT project.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::Path;
use zip::ZipArchive;

use crate::formats::comic::{is_image, natural_cmp};

/// The reading order of a comic: entry paths inside the archive.
#[derive(Debug, Clone, Serialize)]
pub struct ComicBook {
    pub pages: Vec<String>,
}

/// List a comic's pages in reading order.
///
/// Only the archive's central directory is read — no page is decompressed — so
/// this stays fast on a hundred-megabyte issue.
pub fn open(path: &Path) -> Result<ComicBook> {
    let file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let zip = ZipArchive::new(std::io::BufReader::new(file)).context("read comic archive")?;

    let mut pages: Vec<String> = zip
        .file_names()
        .filter(|name| is_image(name))
        .map(|name| name.to_string())
        .collect();

    // Filename order is page order; natural sort so "page10" follows "page9"
    // in the archives that aren't zero-padded.
    pages.sort_by(|a, b| natural_cmp(a, b));

    if pages.is_empty() {
        return Err(anyhow!("this archive has no page images"));
    }
    Ok(ComicBook { pages })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a CBZ in memory with the given entry names.
    fn cbz(names: &[&str]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("shelfmark_comics_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("t{}.cbz", names.len()));
        let file = std::fs::File::create(&path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        for n in names {
            w.start_file::<_, ()>(*n, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(b"x").unwrap();
        }
        w.finish().unwrap();
        path
    }

    #[test]
    fn lists_pages_in_reading_order() {
        let p = cbz(&["p10.jpg", "p2.jpg", "ComicInfo.xml", "p1.jpg"]);
        let book = open(&p).unwrap();
        assert_eq!(book.pages, vec!["p1.jpg", "p2.jpg", "p10.jpg"]);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn ignores_macos_resource_forks() {
        let p = cbz(&["001.jpg", "__MACOSX/._001.jpg", "002.jpg"]);
        let book = open(&p).unwrap();
        assert_eq!(book.pages, vec!["001.jpg", "002.jpg"]);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn an_archive_with_no_images_is_an_error() {
        let p = cbz(&["ComicInfo.xml", "readme.txt"]);
        assert!(open(&p).is_err());
        std::fs::remove_file(p).ok();
    }
}
