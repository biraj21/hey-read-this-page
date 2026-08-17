import type { ReaderBlock } from './playback-protocol.js';

export type PageCapture = {
  title: string;
  url: string;
  blocks: ReaderBlock[];
  startIndex: number;
  startOffset: number;
};

export function captureReadableText(sourceAttribute: string, sourceWrapperAttribute: string): PageCapture {
  const normalizeText = (value: string) =>
    value
      .replace(/\s+/g, ' ')
      .replace(/\u00a0/g, ' ')
      .trim();
  const ignored =
    'script, style, noscript, svg, canvas, nav, aside, footer, form, button, input, select, textarea';
  const selected = normalizeText(window.getSelection()?.toString() || '');
  const title = normalizeText(document.querySelector('h1')?.textContent || document.title) || 'Untitled page';
  removePreviousSourceWrappers();
  const nodes: Node[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);

  const sourceSegments: Array<{ text: string; sourceElementIds: string[] }> = [];
  let nextElementId = 0;
  let currentSegment: { text: string; sourceElementIds: string[]; boundary: Element | null } | null = null;
  let pendingBreaks = 0;
  const finishSegment = () => {
    if (!currentSegment) return;
    const text = normalizeText(currentSegment.text);
    if (text) {
      sourceSegments.push({ text, sourceElementIds: currentSegment.sourceElementIds });
    }
    currentSegment = null;
  };
  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      if (element.tagName === 'BR' && !element.closest(ignored)) pendingBreaks += 1;
      continue;
    }
    const textNode = node as Text;
    const parent = textNode.parentElement;
    const text = normalizeText(textNode.textContent || '');
    if (!parent || !text || isIgnoredText(parent)) continue;

    const boundary = nearestReadingBoundary(parent);
    if (
      currentSegment &&
      (pendingBreaks >= 2 || (boundary && currentSegment.boundary && boundary !== currentSegment.boundary))
    ) {
      finishSegment();
    }
    if (!currentSegment) currentSegment = { text: '', sourceElementIds: [], boundary };
    if (currentSegment.text) currentSegment.text += ' ';
    const sourceElementId = wrapTextNode(textNode, nextElementId + 1);
    nextElementId += 1;
    currentSegment.text += text;
    currentSegment.sourceElementIds.push(sourceElementId);
    pendingBreaks = 0;
  }
  finishSegment();

  const source = sourceSegments.map(({ text }) => text).join('\n\n');
  const blocks: Array<ReaderBlock & { sourceOffset: number }> = [];
  let sourceOffset = 0;
  for (const segment of sourceSegments) {
    const sentences = segment.text.split(/(?<=[.!?])(?=\s+)/);
    let chunk = '';
    let searchFrom = 0;
    const addChunk = (value: string) => {
      // Segment text is already normalized. Keep deliberate <br> markers for the queue preview.
      const text = value.trim();
      if (!text) return;
      const offsetInSegment = segment.text.indexOf(text, searchFrom);
      searchFrom = Math.max(searchFrom, offsetInSegment + text.length);
      blocks.push({
        text,
        preview: text,
        sourceElementIds: segment.sourceElementIds,
        sourceOffset: sourceOffset + Math.max(0, offsetInSegment),
      });
    };
    for (const sentence of sentences) {
      const next = chunk ? `${chunk}${sentence}` : sentence;
      if (next.length > 280 && chunk) {
        addChunk(chunk);
        chunk = sentence.trim();
      } else {
        chunk = next;
      }
    }
    addChunk(chunk);
    sourceOffset += segment.text.length + 2;
  }
  const selectedOffset = selected ? findSelectionOffset(source, selected) : 0;
  const matchingBlock = blocks.findIndex((block) => selectedOffset < block.sourceOffset + block.text.length);
  const startIndex = selectedOffset >= 0 && matchingBlock >= 0 ? matchingBlock : 0;
  const startOffset =
    selectedOffset >= 0 && blocks[startIndex]
      ? Math.max(0, selectedOffset - blocks[startIndex].sourceOffset)
      : 0;
  const readingBlocks =
    selected || !blocks.length ? blocks : [{ text: title, preview: title, sourceOffset: 0 }, ...blocks];
  return {
    title,
    url: location.href,
    startIndex: selected ? startIndex : 0,
    startOffset: selected ? startOffset : 0,
    blocks: readingBlocks.map(({ text, preview, sourceElementIds }) => ({ text, preview, sourceElementIds })),
  };

  function removePreviousSourceWrappers(): void {
    document.querySelectorAll(`[${sourceWrapperAttribute}]`).forEach((wrapper) => {
      wrapper.replaceWith(...Array.from(wrapper.childNodes));
    });
    document.querySelectorAll(`[${sourceAttribute}]`).forEach((element) => {
      element.removeAttribute(sourceAttribute);
    });
  }

  function nearestReadingBoundary(element: Element): Element | null {
    return element.closest('p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, dt, dd');
  }

  function isIgnoredText(element: Element): boolean {
    if (element.closest(ignored)) return true;
    // Preserve ordinary inline link text (for example, “click here”), but do
    // not read standalone in-page reference markers such as “[1]”.
    for (
      let current: Element | null = element;
      current && current !== document.body;
      current = current.parentElement
    ) {
      const text = normalizeText(current.textContent || '');
      if (text.length > 12) return false;
      const linkCount = current.matches('a[href^="#"]') ? 1 : current.querySelectorAll('a[href^="#"]').length;
      if (linkCount === 1 && /^\[?\d+\]?$/.test(text)) return true;
    }
    return false;
  }

  function wrapTextNode(textNode: Text, sequence: number): string {
    const wrapper = document.createElement('span');
    const id = `ll-${Date.now().toString(36)}-${sequence}`;
    wrapper.setAttribute(sourceAttribute, id);
    wrapper.setAttribute(sourceWrapperAttribute, '');
    textNode.replaceWith(wrapper);
    wrapper.append(textNode);
    return id;
  }
  function findSelectionOffset(text: string, selectionText: string): number {
    const exact = text.indexOf(selectionText);
    if (exact >= 0) return exact;
    let normalizedText = '';
    const offsets: number[] = [];
    let previousWasWhitespace = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (/\s/.test(character)) {
        if (!previousWasWhitespace) {
          normalizedText += ' ';
          offsets.push(index);
          previousWasWhitespace = true;
        }
      } else {
        normalizedText += character;
        offsets.push(index);
        previousWasWhitespace = false;
      }
    }
    const normalizedSelection = selectionText.replace(/\s+/g, ' ').trim();
    const normalizedOffset = normalizedText.indexOf(normalizedSelection);
    return normalizedOffset >= 0 ? offsets[normalizedOffset] : -1;
  }
}
