//! Generates a small, spec-compliant sample EPUB in `sample_books/` so the app
//! has something real to scan on first run. Run with:
//!
//!     cargo run --example make_sample
//!
//! (Windows' Compress-Archive writes ZIP entries with backslash separators,
//! which real EPUB readers reject — hence building the archive with the same
//! `zip` crate the app parses with.)

use std::fs::File;
use std::io::Write;

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::path::Path::new("../sample_books");
    std::fs::create_dir_all(dir)?;
    make_epub(dir)?;
    make_pdf(dir)?;
    Ok(())
}

/// A one-page PDF with a title drawn on it, so scanning shows a rendered cover.
fn make_pdf(dir: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let out = dir.join("A Sample PDF.pdf");
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();

    let font_id = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    let content = Content {
        operations: vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 20.into()]),
            Operation::new("Td", vec![50.into(), 400.into()]),
            Operation::new("Tj", vec![Object::string_literal("A Sample PDF")]),
            Operation::new("Td", vec![0.into(), (-30).into()]),
            Operation::new("Tf", vec!["F1".into(), 12.into()]),
            Operation::new("Tj", vec![Object::string_literal("Rendered first-page cover")]),
            Operation::new("ET", vec![]),
        ],
    };
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode()?));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 400.into(), 600.into()],
        "Contents" => content_id,
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    // Document Info so metadata extraction has something to read, too.
    let info_id = doc.add_object(dictionary! {
        "Title" => Object::string_literal("A Sample PDF"),
        "Author" => Object::string_literal("Shelfmark"),
    });
    doc.trailer.set("Info", info_id);
    doc.save(&out)?;
    println!("wrote {}", out.display());
    Ok(())
}

fn make_epub(dir: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let out = dir.join("The Time Machine.epub");

    let mut zip = ZipWriter::new(File::create(&out)?);

    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // The mimetype entry must be first and stored uncompressed.
    zip.start_file("mimetype", stored)?;
    zip.write_all(b"application/epub+zip")?;

    zip.start_file("META-INF/container.xml", deflated)?;
    zip.write_all(CONTAINER.as_bytes())?;

    zip.start_file("OEBPS/content.opf", deflated)?;
    zip.write_all(OPF.as_bytes())?;

    zip.start_file("OEBPS/ch1.xhtml", deflated)?;
    zip.write_all(chapter("Chapter One", 200).as_bytes())?;

    zip.start_file("OEBPS/ch2.xhtml", deflated)?;
    zip.write_all(chapter("Chapter Two", 300).as_bytes())?;

    zip.start_file("OEBPS/cover.svg", deflated)?;
    zip.write_all(COVER.as_bytes())?;

    zip.finish()?;
    println!("wrote {}", out.display());
    Ok(())
}

fn chapter(title: &str, words: usize) -> String {
    let mut body = String::new();
    for i in 1..=words {
        body.push_str(&format!("word{i} "));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>{title}</title></head>\
         <body><h1>{title}</h1><p>{body}</p></body></html>"
    )
}

const CONTAINER: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

const OPF: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Time Machine</dc:title>
    <dc:creator>H. G. Wells</dc:creator>
    <dc:publisher>Vault Classics</dc:publisher>
    <dc:date>1895</dc:date>
    <dc:language>en</dc:language>
    <dc:subject>Science Fiction</dc:subject>
    <dc:subject>Classic</dc:subject>
    <dc:description>A Victorian scientist travels to the far future.</dc:description>
    <dc:identifier id="bookid" opf:scheme="ISBN">9780000000001</dc:identifier>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="cover-img" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>"#;

const COVER: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="rgb(15,118,110)"/><text x="100" y="150" fill="white" font-size="16" text-anchor="middle">The Time Machine</text></svg>"#;
