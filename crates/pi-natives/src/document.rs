//! Local-only AnyDoc text conversion and embedded image recovery.

use anydoc::{
	ConvertError, Format,
	model::{Asset, Block, CellSlot, ImageSource, Inline},
};
use napi::{
	Result, Unknown,
	bindgen_prelude::{Buffer, Uint8Array},
};
use napi_derive::napi;

use crate::task::{self, CancelToken};

const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_IMAGES: usize = 12;
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// An embedded image, not a rendered document page.
#[napi(object)]
pub struct DocumentImage {
	pub origin:    String,
	pub mime_type: String,
	pub data:      Buffer,
}

/// AnyDoc output. Failure metadata must never be mistaken for extracted text.
#[napi(object)]
pub struct DocumentMarkdownResult {
	pub markdown:          String,
	pub error:             Option<String>,
	pub error_code:        Option<String>,
	/// Present only for PDFs, including NeedsOcr errors.
	pub page_count:        Option<u32>,
	pub pages_needing_ocr: Vec<u32>,
	pub images:            Vec<DocumentImage>,
	/// Includes images omitted by the transfer budget.
	pub image_count:       u32,
}

fn failed(error: ConvertError) -> DocumentMarkdownResult {
	let (page_count, pages_needing_ocr) = match &error {
		ConvertError::NeedsOcr { pages, page_count } => (Some(*page_count), pages.clone()),
		_ => (None, Vec::new()),
	};
	DocumentMarkdownResult {
		markdown: String::new(),
		error: Some(error.to_string()),
		error_code: Some(error.code().to_owned()),
		page_count,
		pages_needing_ocr,
		images: Vec::new(),
		image_count: 0,
	}
}

fn missing_image_sources(blocks: &[Block], assets: &[Asset]) -> bool {
	fn inlines_missing(inlines: &[Inline], assets: &[Asset]) -> bool {
		inlines.iter().any(|inline| match inline {
			Inline::Image { source: ImageSource::Asset(id), .. } => assets
				.get(id.0)
				.is_none_or(|asset| asset.bytes.is_empty() || !asset.media_type.starts_with("image/")),
			Inline::Image { .. } => true,
			Inline::Link { content, .. } => inlines_missing(content, assets),
			_ => false,
		})
	}
	blocks.iter().any(|block| match block {
		Block::Heading { content, .. } | Block::Paragraph(content) => {
			inlines_missing(content, assets)
		},
		Block::List(list) => list
			.items
			.iter()
			.any(|item| missing_image_sources(&item.blocks, assets)),
		Block::BlockQuote(blocks) => missing_image_sources(blocks, assets),
		Block::Table(table) => table.grid.iter().flatten().any(|slot| match slot {
			CellSlot::Origin(cell) => missing_image_sources(&cell.blocks, assets),
			CellSlot::Covered { .. } => false,
		}),
		_ => false,
	})
}

/// Convert with Firecrawl AnyDoc locally; no hosted OCR or network requests.
/// Input is copied before dispatch to isolate JavaScript buffer mutation.
#[napi(js_name = "documentToMarkdown")]
pub fn document_to_markdown(
	input: Uint8Array,
	extension: String,
	signal: Option<Unknown>,
) -> Result<task::Promise<DocumentMarkdownResult>> {
	if input.len() > MAX_INPUT_BYTES {
		return Err(napi::Error::from_reason("Document exceeds the 64 MiB local conversion limit"));
	}
	let cancel = CancelToken::new(Some(30_000), signal);
	cancel.heartbeat()?;
	let input = input.to_vec();
	Ok(task::blocking("document.to_markdown", cancel, move |cancel| {
		cancel.heartbeat()?;
		let format = Format::from_bytes(&input)
			.or_else(|| Format::from_extension(extension.trim_start_matches('.')));
		let mut result = match anydoc::to_markdown_bytes(&input, format) {
			Ok(markdown) => DocumentMarkdownResult {
				markdown,
				error: None,
				error_code: None,
				page_count: None,
				pages_needing_ocr: Vec::new(),
				images: Vec::new(),
				image_count: 0,
			},
			Err(error) => failed(error),
		};
		cancel.heartbeat()?;
		if format == Some(Format::Pdf)
			&& (result.error.is_none() || result.error_code.as_deref() == Some("needsOcr"))
		{
			// AnyDoc omits PDF inspection metadata and discards all text on
			// NeedsOcr. Reuse the existing bridge to recover ordered text pages
			// and detect encoding failures without representing either as complete.
			if let Ok(pdf) = crate::pdf::convert_pdf(&input) {
				result.page_count = Some(pdf.page_count);
				if result.error.is_some() {
					result.markdown = pdf.markdown;
				}
				if pdf.has_encoding_issues {
					result.error =
						Some("PDF has broken font encodings; visual transcription required".to_owned());
					result.error_code = Some("encoding".to_owned());
					result.pages_needing_ocr.clear();
				}
			}
		}
		// AnyDoc's Markdown serializer is private. Its public document API is
		// required separately to distinguish alt text from actual image text and
		// recover image payloads. PDFs have no document-model representation.
		if result.error.is_none() && format != Some(Format::Pdf) && format != Some(Format::Csv) {
			match anydoc::to_document(&input, format) {
				Ok(document) => {
					if missing_image_sources(&document.blocks, &document.assets)
						|| document
							.notes
							.iter()
							.any(|note| missing_image_sources(&note.blocks, &document.assets))
					{
						result.error = Some(
							"Document contains image references without locally available image data"
								.to_owned(),
						);
						result.error_code = Some("missingImages".to_owned());
					}
					let mut transferred = 0;
					for asset in document.assets {
						cancel.heartbeat()?;
						if !asset.media_type.starts_with("image/") {
							continue;
						}
						result.image_count += 1;
						if result.images.len() >= MAX_IMAGES
							|| asset.bytes.len() > MAX_IMAGE_BYTES.saturating_sub(transferred)
						{
							continue;
						}
						transferred += asset.bytes.len();
						result.images.push(DocumentImage {
							origin:    asset.origin_part,
							mime_type: asset.media_type,
							data:      asset.bytes.into(),
						});
					}
				},
				Err(error) => {
					result.error = Some(error.to_string());
					result.error_code = Some(error.code().to_owned());
				},
			}
		}
		cancel.heartbeat()?;
		Ok(result)
	}))
}
