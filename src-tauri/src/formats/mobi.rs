//! MOBI / AZW extraction. These share the Palm Database container: record 0
//! holds a PalmDOC header, a MOBI header, and an optional EXTH block of tagged
//! metadata records. We pull the full title, author, and a few other fields, and
//! estimate size metrics from the uncompressed text length.

use anyhow::{anyhow, Result};

use super::{clean, ExtractedMeta};

// EXTH record type ids.
const EXTH_AUTHOR: u32 = 100;
const EXTH_PUBLISHER: u32 = 101;
const EXTH_DESCRIPTION: u32 = 103;
const EXTH_ISBN: u32 = 104;
const EXTH_SUBJECT: u32 = 105;
const EXTH_PUBDATE: u32 = 106;

/// Average bytes of uncompressed text per word (word + trailing space).
const BYTES_PER_WORD: i64 = 6;

pub fn extract(path: &std::path::Path, words_per_page: i64) -> Result<ExtractedMeta> {
    let data = std::fs::read(path)?;
    if data.len() < 78 {
        return Err(anyhow!("file too small to be a MOBI"));
    }

    // Palm record offset table → record 0 location.
    let num_records = be_u16(&data, 76)? as usize;
    if num_records == 0 {
        return Err(anyhow!("no records"));
    }
    let rec0_start = be_u32(&data, 78)? as usize;
    if rec0_start + 16 > data.len() || &data[rec0_start + 16..rec0_start + 20] != b"MOBI" {
        return Err(anyhow!("record 0 is not a MOBI header"));
    }

    let mut meta = ExtractedMeta::default();

    // PalmDOC header: uncompressed text length → word/page estimates.
    let text_len = be_u32(&data, rec0_start + 4)? as i64;
    if text_len > 0 {
        let words = (text_len / BYTES_PER_WORD).max(1);
        meta.words = Some(words);
        meta.pages = Some((words / words_per_page.max(1)).max(1));
        meta.words_estimated = true;
    }

    // MOBI header fields.
    let mobi_hdr_len = be_u32(&data, rec0_start + 20)? as usize;
    let text_encoding = be_u32(&data, rec0_start + 28).unwrap_or(1252);

    // Full title lives at rec0_start + full_name_offset.
    let full_name_off = be_u32(&data, rec0_start + 0x54)? as usize;
    let full_name_len = be_u32(&data, rec0_start + 0x58)? as usize;
    let title_start = rec0_start + full_name_off;
    if title_start + full_name_len <= data.len() && full_name_len > 0 {
        let raw = &data[title_start..title_start + full_name_len];
        meta.title = clean(&decode(raw, text_encoding));
    }

    // EXTH block (present when bit 0x40 of the flags at 0x80 is set).
    let exth_flags = be_u32(&data, rec0_start + 0x80).unwrap_or(0);
    if exth_flags & 0x40 != 0 {
        let exth_start = rec0_start + 16 + mobi_hdr_len;
        if let Ok(records) = parse_exth(&data, exth_start, text_encoding) {
            let mut subjects: Vec<String> = Vec::new();
            for (typ, val) in records {
                match typ {
                    EXTH_AUTHOR if meta.author.is_none() => meta.author = clean(&val),
                    EXTH_PUBLISHER if meta.publisher.is_none() => meta.publisher = clean(&val),
                    EXTH_DESCRIPTION if meta.description.is_none() => meta.description = clean(&val),
                    EXTH_ISBN if meta.isbn.is_none() => meta.isbn = clean(&val),
                    EXTH_PUBDATE if meta.published_date.is_none() => {
                        meta.published_date = clean(&val)
                    }
                    EXTH_SUBJECT => {
                        if let Some(s) = clean(&val) {
                            subjects.push(s);
                        }
                    }
                    _ => {}
                }
            }
            if !subjects.is_empty() {
                meta.subjects = Some(subjects.join(", "));
            }
        }
    }

    Ok(meta)
}

/// Parse the EXTH record list into (type, decoded value) pairs.
fn parse_exth(data: &[u8], start: usize, encoding: u32) -> Result<Vec<(u32, String)>> {
    if start + 12 > data.len() || &data[start..start + 4] != b"EXTH" {
        return Err(anyhow!("no EXTH header at expected offset"));
    }
    let count = be_u32(data, start + 8)? as usize;
    let mut out = Vec::with_capacity(count);
    let mut pos = start + 12;
    for _ in 0..count {
        if pos + 8 > data.len() {
            break;
        }
        let typ = be_u32(data, pos)?;
        let len = be_u32(data, pos + 4)? as usize;
        if len < 8 || pos + len > data.len() {
            break;
        }
        let val = decode(&data[pos + 8..pos + len], encoding);
        out.push((typ, val));
        pos += len;
    }
    Ok(out)
}

fn decode(bytes: &[u8], encoding: u32) -> String {
    if encoding == 65001 {
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        // Windows-1252 ≈ Latin-1 for the common printable range.
        bytes.iter().map(|&b| b as char).collect()
    }
}

fn be_u16(d: &[u8], off: usize) -> Result<u16> {
    d.get(off..off + 2)
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
        .ok_or_else(|| anyhow!("read u16 out of bounds at {off}"))
}

fn be_u32(d: &[u8], off: usize) -> Result<u32> {
    d.get(off..off + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| anyhow!("read u32 out of bounds at {off}"))
}
