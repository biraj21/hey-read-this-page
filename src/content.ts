import { captureReadableText } from './page-capture.js';
import { PAGE_COMMAND, PAGE_MARKER } from './shared.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case PAGE_COMMAND.CAPTURE:
      sendResponse({ ok: true, page: captureReadableText(PAGE_MARKER.SOURCE_ELEMENT) });
      return;
    case PAGE_COMMAND.FOCUS_SOURCE:
      focusSourceElements(message.sourceElementIds);
      sendResponse({ ok: true });
      return;
    case PAGE_COMMAND.CLEAR_SOURCE_FOCUS:
      clearSourceFocus();
      sendResponse({ ok: true });
      return;
  }
});

function focusSourceElements(sourceElementIds: string[] | undefined): void {
  clearSourceFocus();
  if (!sourceElementIds?.length) return;

  const elements = sourceElementIds
    .map((id) => document.querySelector<HTMLElement>(`[${PAGE_MARKER.SOURCE_ELEMENT}="${CSS.escape(id)}"]`))
    .filter((element): element is HTMLElement => Boolean(element));
  for (const element of elements) {
    element.setAttribute(PAGE_MARKER.ORIGINAL_BACKGROUND, element.style.getPropertyValue('background-color'));
    element.setAttribute(
      PAGE_MARKER.ORIGINAL_BACKGROUND_PRIORITY,
      element.style.getPropertyPriority('background-color'),
    );
    element.setAttribute(PAGE_MARKER.ACTIVE_SOURCE_ELEMENT, 'true');
    element.style.setProperty('background-color', 'rgba(255, 221, 118, 0.58)', 'important');
  }
  elements.at(0)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
}

function clearSourceFocus(): void {
  document.querySelectorAll<HTMLElement>(`[${PAGE_MARKER.ACTIVE_SOURCE_ELEMENT}]`).forEach((element) => {
    const originalBackground = element.getAttribute(PAGE_MARKER.ORIGINAL_BACKGROUND);
    const originalPriority = element.getAttribute(PAGE_MARKER.ORIGINAL_BACKGROUND_PRIORITY) || '';
    if (originalBackground) {
      element.style.setProperty('background-color', originalBackground, originalPriority);
    } else {
      element.style.removeProperty('background-color');
    }
    element.removeAttribute(PAGE_MARKER.ACTIVE_SOURCE_ELEMENT);
    element.removeAttribute(PAGE_MARKER.ORIGINAL_BACKGROUND);
    element.removeAttribute(PAGE_MARKER.ORIGINAL_BACKGROUND_PRIORITY);
  });
}
