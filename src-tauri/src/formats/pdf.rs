//! PDF extraction. We read the document Info dictionary (Title / Author /
//! Subject / Keywords) and count pages via lopdf. PDFs don't expose a reliable
//! word count, so words are estimated from the page count.

use anyhow::{Context, Result};
use lopdf::{Document, Object};

use super::{clean, ExtractedMeta};

pub fn extract(path: &std::path::Path, words_per_page: i64) -> Result<ExtractedMeta> {
    let doc = Document::load(path).context("parse pdf")?;
    let mut meta = ExtractedMeta::default();

    let pages = doc.get_pages().len() as i64;
    if pages > 0 {
        meta.pages = Some(pages);
        meta.words = Some(pages * words_per_page.max(1));
        meta.words_estimated = true;
    }

    // Info dictionary (may be a direct dict or a reference).
    if let Some(dict) = info_dict(&doc) {
        meta.title = info_str(dict, b"Title").and_then(|s| clean(&s));
        meta.author = info_str(dict, b"Author").and_then(|s| clean(&s));
        meta.subjects = info_str(dict, b"Keywords")
            .or_else(|| info_str(dict, b"Subject"))
            .and_then(|s| clean(&s));
        // Metadata dates look like "D:20180101..." — surface the year onward.
        meta.published_date = info_str(dict, b"CreationDate").and_then(|s| clean_pdf_date(&s));
    }

    Ok(meta)
}

fn info_dict(doc: &Document) -> Option<&lopdf::Dictionary> {
    let obj = doc.trailer.get(b"Info").ok()?;
    let resolved = match obj {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    resolved.as_dict().ok()
}

fn info_str(dict: &lopdf::Dictionary, key: &[u8]) -> Option<String> {
    let bytes = dict.get(key).ok()?.as_str().ok()?;
    Some(decode_pdf_string(bytes))
}

/// PDF text strings are either UTF-16BE (with a BOM) or PDFDocEncoding (a
/// Latin-1 superset). Decode both to a Rust string.
fn decode_pdf_string(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        // Treat each byte as a Latin-1 code point.
        bytes.iter().map(|&b| b as char).collect()
    }
}

/// Turn a PDF date string ("D:20180415120000Z") into a plain "YYYY" year.
fn clean_pdf_date(s: &str) -> Option<String> {
    let digits: String = s.trim_start_matches("D:").chars().take(4).collect();
    if digits.len() == 4 && digits.chars().all(|c| c.is_ascii_digit()) {
        Some(digits)
    } else {
        None
    }
}
