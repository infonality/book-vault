//! Per-format metadata extraction. Each supported ebook format has a module that
//! pulls whatever bibliographic data and size metrics it can from the file
//! itself, plus an embedded cover image when one is present.

mod epub;
mod mobi;
mod pdf;

use std::path::Path;

/// A cover image lifted out of a book file, kept in memory until the caller
/// decides where to store it.
pub struct CoverImage {
    pub bytes: Vec<u8>,
    /// File extension without the dot, e.g. "jpg" / "png".
    pub ext: String,
}

/// Everything we could extract from a single book file. All fields are optional
/// because formats vary wildly in what they carry.
#[derive(Default)]
pub struct ExtractedMeta {
    pub title: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub subjects: Option<String>,
    pub pages: Option<i64>,
    pub words: Option<i64>,
    /// True when pages/words are estimated rather than counted from the text.
    pub words_estimated: bool,
    pub cover: Option<CoverImage>,
}

/// The format id we store for a given path, if supported.
pub fn detect_format(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    match ext.as_str() {
        "epub" => Some("epub"),
        "pdf" => Some("pdf"),
        // Kindle formats all use the MOBI container family.
        "mobi" | "azw" | "azw3" => Some("mobi"),
        _ => None,
    }
}

/// Extract metadata for a book. `words_per_page` drives word estimates for
/// formats that don't expose a real word count. Never returns hard errors for a
/// single unreadable file — the worst case is an empty result, so a scan of a
/// mixed folder always makes progress.
pub fn extract(path: &Path, format: &str, words_per_page: i64) -> ExtractedMeta {
    let result = match format {
        "epub" => epub::extract(path),
        "pdf" => pdf::extract(path, words_per_page),
        "mobi" => mobi::extract(path, words_per_page),
        _ => Ok(ExtractedMeta::default()),
    };
    match result {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[extract] {}: {e:#}", path.display());
            ExtractedMeta::default()
        }
    }
}

/// Collapse repeated whitespace and trim; returns None for empty strings.
pub(crate) fn clean(s: &str) -> Option<String> {
    let out = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Count whitespace-separated tokens in already-detagged text.
pub(crate) fn count_words(text: &str) -> i64 {
    text.split_whitespace().count() as i64
}

/// Strip HTML/XML tags from a fragment, returning plain text with tag positions
/// replaced by spaces (so words don't run together across element boundaries).
pub(crate) fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    /// Build a small, spec-compliant EPUB in a temp file and return its path.
    fn build_epub() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("bookvault_test_{}.epub", std::process::id()));
        let mut zip = ZipWriter::new(std::fs::File::create(&path).unwrap());
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();

        zip.start_file("META-INF/container.xml", deflated).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?>
            <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles><rootfile full-path="OEBPS/content.opf"
                media-type="application/oebps-package+xml"/></rootfiles>
            </container>"#,
        )
        .unwrap();

        zip.start_file("OEBPS/content.opf", deflated).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?>
            <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
              <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"
                        xmlns:opf="http://www.idpf.org/2007/opf">
                <dc:title>The Time Machine</dc:title>
                <dc:creator>H. G. Wells</dc:creator>
                <dc:subject>Science Fiction</dc:subject>
                <dc:subject>Classic</dc:subject>
                <dc:identifier id="id" opf:scheme="ISBN">9780000000001</dc:identifier>
              </metadata>
              <manifest>
                <item id="cover-img" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>
                <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
              </manifest>
              <spine><itemref idref="c1"/></spine>
            </package>"#,
        )
        .unwrap();

        // 250 body words + 2 heading words = 252 total.
        let mut body = String::from("<html><body><h1>Chapter One</h1><p>");
        for i in 1..=250 {
            body.push_str(&format!("word{i} "));
        }
        body.push_str("</p></body></html>");
        zip.start_file("OEBPS/c1.xhtml", deflated).unwrap();
        zip.write_all(body.as_bytes()).unwrap();

        zip.start_file("OEBPS/cover.svg", deflated).unwrap();
        zip.write_all(br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#).unwrap();

        zip.finish().unwrap();
        path
    }

    #[test]
    fn extracts_epub_metadata() {
        let path = build_epub();
        let m = extract(&path, "epub", 275);
        std::fs::remove_file(&path).ok();

        assert_eq!(m.title.as_deref(), Some("The Time Machine"));
        assert_eq!(m.author.as_deref(), Some("H. G. Wells"));
        assert_eq!(m.isbn.as_deref(), Some("9780000000001"));
        assert_eq!(m.subjects.as_deref(), Some("Science Fiction, Classic"));
        assert_eq!(m.words, Some(252));
        assert!(!m.words_estimated);
        assert!(m.pages.unwrap() >= 1);
        assert!(m.cover.is_some(), "cover should be extracted");
    }

    #[test]
    fn strip_tags_separates_words() {
        assert_eq!(count_words(&strip_tags("<p>one</p><p>two</p>")), 2);
    }
}
