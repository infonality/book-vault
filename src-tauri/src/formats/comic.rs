//! Comic archive extraction.
//!
//! A CBZ is just a ZIP of page images in filename order. Many are tagged with a
//! `ComicInfo.xml` — the ComicRack schema, which is what most taggers write —
//! carrying series, issue number, creators and a summary.
//!
//! CBR is a RAR archive. RAR's reference decoder ships under a licence that
//! isn't compatible with vendoring into an MIT project, so we don't read inside
//! one: a CBR is catalogued from its filename with no cover and no page count.
//! That's a deliberate limitation, not an oversight.

use std::io::Read;

use anyhow::{Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use super::{clean, CoverImage, ExtractedMeta};

/// Page images, in the order a reader would see them.
fn is_image(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]
        .iter()
        .any(|e| lower.ends_with(e))
        // macOS archives carry a parallel `__MACOSX` tree of resource forks.
        && !lower.starts_with("__macosx/")
        && !lower.contains("/._")
}

pub fn extract(path: &std::path::Path) -> Result<ExtractedMeta> {
    let file = std::fs::File::open(path)?;
    let mut zip = ZipArchive::new(std::io::BufReader::new(file)).context("open cbz archive")?;

    let mut images: Vec<String> = Vec::new();
    let mut info_xml: Option<String> = None;
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index(i) else { continue };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if is_image(&name) {
            images.push(name);
        } else if name.to_ascii_lowercase().ends_with("comicinfo.xml") {
            let mut s = String::new();
            let mut e = entry;
            if e.read_to_string(&mut s).is_ok() {
                info_xml = Some(s);
            }
        }
    }
    // Page order is filename order; natural sort so "page10" follows "page9".
    images.sort_by(|a, b| natural_cmp(a, b));

    let mut meta = ExtractedMeta {
        // Pages are images. There is no text, so no word count — leaving these
        // as None keeps comics out of the reading totals rather than inventing
        // an estimate for them.
        pages: if images.is_empty() { None } else { Some(images.len() as i64) },
        words: None,
        words_estimated: false,
        ..Default::default()
    };

    if let Some(xml) = &info_xml {
        apply_comic_info(&mut meta, xml);
    }

    // Cover: the first page.
    if let Some(first) = images.first() {
        if let Ok(mut f) = zip.by_name(first) {
            let mut bytes = Vec::new();
            if f.read_to_end(&mut bytes).is_ok() && !bytes.is_empty() {
                meta.cover = Some(CoverImage { bytes, ext: image_ext(first) });
            }
        }
    }

    Ok(meta)
}

/// Compare names so embedded numbers order numerically: `p2` before `p10`.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut nx = String::new();
                let mut ny = String::new();
                while ai.peek().is_some_and(|c| c.is_ascii_digit()) {
                    nx.push(ai.next().unwrap());
                }
                while bi.peek().is_some_and(|c| c.is_ascii_digit()) {
                    ny.push(bi.next().unwrap());
                }
                let vx: u64 = nx.parse().unwrap_or(0);
                let vy: u64 = ny.parse().unwrap_or(0);
                if vx != vy {
                    return vx.cmp(&vy);
                }
            }
            (Some(x), Some(y)) => {
                ai.next();
                bi.next();
                if x != y {
                    return x.cmp(&y);
                }
            }
        }
    }
}

/// Read the ComicRack `ComicInfo.xml` tags we can map onto a library entry.
fn apply_comic_info(meta: &mut ExtractedMeta, xml: &str) {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut field: Option<String> = None;

    let mut series = None;
    let mut number = None;
    let mut title = None;
    let mut writer = None;
    let mut penciller = None;
    let mut year = None;
    let mut genres: Vec<String> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                field = Some(String::from_utf8_lossy(e.name().as_ref()).to_ascii_lowercase());
            }
            Ok(Event::Text(t)) => {
                let Some(f) = field.as_deref() else { continue };
                let v = t.xml10_content().unwrap_or_default().to_string();
                let v = v.trim().to_string();
                if v.is_empty() {
                    continue;
                }
                match f {
                    "series" => series = Some(v),
                    "number" => number = Some(v),
                    "title" => title = Some(v),
                    "writer" => writer = Some(v),
                    "penciller" => penciller = Some(v),
                    "publisher" => meta.publisher = clean(&v),
                    "year" => year = Some(v),
                    "summary" | "notes" => {
                        if meta.description.is_none() {
                            meta.description = clean(&super::strip_tags(&v));
                        }
                    }
                    "genre" => genres.push(v),
                    "languageiso" => meta.language = clean(&v),
                    "pagecount" => {
                        if let Ok(n) = v.parse::<i64>() {
                            if n > 0 {
                                meta.pages = Some(n);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(_)) => field = None,
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    // A comic's useful title is usually "Series #12", with the issue's own
    // title as a subtitle when it has one.
    meta.title = match (&series, &number, &title) {
        (Some(s), Some(n), Some(t)) => Some(format!("{s} #{n}: {t}")),
        (Some(s), Some(n), None) => Some(format!("{s} #{n}")),
        (Some(s), None, Some(t)) => Some(format!("{s}: {t}")),
        (Some(s), None, None) => Some(s.clone()),
        (None, _, Some(t)) => Some(t.clone()),
        _ => None,
    };
    meta.series = series;
    meta.author = match (writer, penciller) {
        (Some(w), Some(p)) if w != p => Some(format!("{w}, {p}")),
        (Some(w), _) => Some(w),
        (None, Some(p)) => Some(p),
        (None, None) => None,
    };
    meta.published_date = year;
    if !genres.is_empty() {
        meta.subjects = Some(genres.join(", "));
    }
}

fn image_ext(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    for ext in ["jpg", "jpeg", "png", "gif", "webp", "bmp"] {
        if lower.ends_with(&format!(".{ext}")) {
            return if ext == "jpeg" { "jpg".into() } else { ext.into() };
        }
    }
    "jpg".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_pages_numerically_not_lexically() {
        let mut v = vec!["p10.jpg".to_string(), "p2.jpg".into(), "p1.jpg".into()];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["p1.jpg", "p2.jpg", "p10.jpg"]);
    }

    #[test]
    fn skips_macos_resource_forks() {
        assert!(is_image("pages/001.jpg"));
        assert!(!is_image("__MACOSX/pages/._001.jpg"));
        assert!(!is_image("ComicInfo.xml"));
    }

    #[test]
    fn builds_a_title_from_series_and_number() {
        let mut m = ExtractedMeta::default();
        apply_comic_info(
            &mut m,
            r#"<ComicInfo><Series>Saga</Series><Number>12</Number><Writer>B. K. Vaughan</Writer><PageCount>24</PageCount></ComicInfo>"#,
        );
        assert_eq!(m.title.as_deref(), Some("Saga #12"));
        assert_eq!(m.series.as_deref(), Some("Saga"));
        assert_eq!(m.author.as_deref(), Some("B. K. Vaughan"));
        assert_eq!(m.pages, Some(24));
    }
}
