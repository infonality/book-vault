//! Online metadata via the Open Library API (free, no key required).
//!
//! Goodreads retired its public API in 2020, so there's no supported way to
//! query it programmatically. Open Library is the practical stand-in: it returns
//! the same kind of catalogue data — title, author, year, page count, subjects,
//! ISBN — plus cover art, and needs no credentials.

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::models::MetaCandidate;

const SEARCH_URL: &str = "https://openlibrary.org/search.json";
const COVER_URL: &str = "https://covers.openlibrary.org/b/id";

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    docs: Vec<SearchDoc>,
}

#[derive(Deserialize)]
struct SearchDoc {
    key: Option<String>,
    title: Option<String>,
    #[serde(default)]
    author_name: Vec<String>,
    first_publish_year: Option<i64>,
    number_of_pages_median: Option<i64>,
    cover_i: Option<i64>,
    #[serde(default)]
    isbn: Vec<String>,
    #[serde(default)]
    publisher: Vec<String>,
    #[serde(default)]
    subject: Vec<String>,
}

/// Search Open Library and return up to a handful of candidate matches.
pub async fn search(http: &reqwest::Client, query: &str) -> Result<Vec<MetaCandidate>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!(
        "{SEARCH_URL}?q={}&limit=8&fields=key,title,author_name,first_publish_year,\
         number_of_pages_median,cover_i,isbn,publisher,subject",
        urlencoding::encode(q)
    );
    let resp: SearchResponse = http
        .get(&url)
        .send()
        .await
        .context("Open Library search request failed")?
        .error_for_status()
        .context("Open Library returned an error")?
        .json()
        .await
        .context("could not parse Open Library response")?;

    let candidates = resp
        .docs
        .into_iter()
        .filter_map(|d| {
            let title = d.title?;
            let isbn = d
                .isbn
                .iter()
                .find(|s| s.len() == 13)
                .or_else(|| d.isbn.first())
                .cloned();
            let subjects = if d.subject.is_empty() {
                None
            } else {
                Some(d.subject.into_iter().take(6).collect::<Vec<_>>().join(", "))
            };
            Some(MetaCandidate {
                title,
                author: d.author_name.into_iter().next(),
                year: d.first_publish_year,
                pages: d.number_of_pages_median,
                publisher: d.publisher.into_iter().next(),
                isbn,
                subjects,
                // `default=false` makes Open Library 404 instead of returning a
                // blank 1x1 placeholder when a cover isn't actually available.
                cover_url: d
                    .cover_i
                    .map(|id| format!("{COVER_URL}/id/{id}-L.jpg?default=false")),
                work_key: d.key,
            })
        })
        .collect();
    Ok(candidates)
}

/// Best-effort description lookup for a work (search results don't include it).
pub async fn fetch_description(http: &reqwest::Client, work_key: &str) -> Option<String> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Desc {
        Text(String),
        Obj { value: String },
    }
    #[derive(Deserialize)]
    struct Work {
        description: Option<Desc>,
    }
    let url = format!("https://openlibrary.org{work_key}.json");
    let work: Work = http.get(&url).send().await.ok()?.json().await.ok()?;
    match work.description? {
        Desc::Text(s) => Some(s),
        Desc::Obj { value } => Some(value),
    }
    .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
    .filter(|s| !s.is_empty())
}

/// Smallest response we'll accept as a real cover; anything less is treated as a
/// placeholder (Open Library's blank cover is a ~43-byte 1x1 GIF).
const MIN_COVER_BYTES: usize = 2048;

/// Download a cover image; returns the raw bytes (assumed JPEG from Open
/// Library). Rejects missing covers (404 via `default=false`) and tiny
/// placeholder images.
pub async fn download_cover(http: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let bytes = http
        .get(url)
        .send()
        .await
        .context("cover download failed")?
        .error_for_status()
        .context("cover not available")?
        .bytes()
        .await
        .context("reading cover bytes")?;
    if bytes.len() < MIN_COVER_BYTES {
        anyhow::bail!("cover is a placeholder ({} bytes)", bytes.len());
    }
    Ok(bytes.to_vec())
}
