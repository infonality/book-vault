/**
 * Text anchoring inside the reader frame.
 *
 * Highlights and search results are located by character offsets into the
 * chapter's *rendered* text — the concatenation of its text nodes. That anchor
 * is stable across a font change, a resize, or a switch to two columns, none of
 * which alter the text itself. It deliberately does not use the tag-stripped
 * text the Rust side counts for progress: that inserts whitespace between
 * elements, so its offsets would drift from the DOM's.
 *
 * The frame runs without script permission, so everything here is executed by
 * the parent through its same-origin handle on the document.
 */

/** Every text node in document order, skipping ones we inject ourselves. */
function textNodes(doc: Document): Text[] {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (el.closest("script, style, [data-bv-skip]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

/** Full rendered text of the chapter, matching the offsets used for anchors. */
export function chapterText(doc: Document): string {
  return textNodes(doc)
    .map((n) => n.data)
    .join("");
}

/** Turn a character range into a DOM Range, or null if it's out of bounds. */
export function rangeForOffsets(doc: Document, start: number, end: number): Range | null {
  if (end <= start) return null;
  const nodes = textNodes(doc);
  let seen = 0;
  let range: Range | null = null;
  for (const node of nodes) {
    const len = node.data.length;
    if (!range && seen + len > start) {
      range = doc.createRange();
      range.setStart(node, Math.max(0, start - seen));
    }
    if (range && seen + len >= end) {
      range.setEnd(node, Math.max(0, end - seen));
      return range;
    }
    seen += len;
  }
  // Ran past the end of the chapter — clamp to the last node we saw.
  if (range && nodes.length) {
    const last = nodes[nodes.length - 1];
    range.setEnd(last, last.data.length);
    return range;
  }
  return null;
}

/** Character offsets of the current selection, or null when nothing is selected. */
export function offsetsForSelection(doc: Document): { start: number; end: number; text: string } | null {
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const text = sel.toString();
  if (!text.trim()) return null;

  const nodes = textNodes(doc);
  let seen = 0;
  let start = -1;
  let end = -1;
  for (const node of nodes) {
    if (node === range.startContainer) start = seen + range.startOffset;
    if (node === range.endContainer) end = seen + range.endOffset;
    seen += node.data.length;
  }
  // Selections that begin or end on an element rather than a text node.
  if (start < 0 || end < 0) {
    const idx = chapterText(doc).indexOf(text);
    if (idx < 0) return null;
    return { start: idx, end: idx + text.length, text };
  }
  return start < end ? { start, end, text } : null;
}

/** Offsets of the nth case-insensitive occurrence of `needle`. */
export function offsetsForOccurrence(
  doc: Document,
  needle: string,
  occurrence: number
): { start: number; end: number } | null {
  if (!needle) return null;
  const hay = chapterText(doc).toLowerCase();
  const q = needle.toLowerCase();
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    const at = hay.indexOf(q, from);
    if (at < 0) return null;
    if (i === occurrence) return { start: at, end: at + q.length };
    from = at + q.length;
  }
  return null;
}

/** Which page a range falls on, given the width of one page. */
export function pageForRange(doc: Document, range: Range, pageWidth: number): number {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return 0;
  const x = rect.left + doc.documentElement.scrollLeft;
  return Math.max(0, Math.floor(x / pageWidth));
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "rgba(255, 214, 0, .38)",
  green: "rgba(52, 211, 153, .34)",
  blue: "rgba(96, 165, 250, .34)",
  pink: "rgba(244, 114, 182, .34)",
};

/** Remove every mark this module previously drew. */
export function clearMarks(doc: Document, attr: string) {
  doc.querySelectorAll(`[${attr}]`).forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  });
}

/**
 * Wrap a range in `<mark>` elements. A range can span several text nodes and
 * cross element boundaries, so `surroundContents` won't do — each intersecting
 * node gets its own mark instead.
 */
export function markRange(
  doc: Document,
  range: Range,
  attr: string,
  value: string,
  background: string
) {
  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    if (range.intersectsNode(t)) nodes.push(t);
  }

  for (const node of nodes) {
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    if (to <= from) continue;

    const target = node.splitText(from);
    if (to - from < target.data.length) target.splitText(to - from);

    const mark = doc.createElement("mark");
    mark.setAttribute(attr, value);
    mark.style.background = background;
    mark.style.color = "inherit";
    mark.style.borderRadius = "2px";
    target.parentNode?.replaceChild(mark, target);
    mark.appendChild(target);
  }
}
