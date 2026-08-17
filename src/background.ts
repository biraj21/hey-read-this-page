import type { PlaybackSnapshot } from './playback-protocol.js';
import { PAGE_COMMAND, PLAYBACK_ACTION, PLAYBACK_TARGET, RUNTIME_MESSAGE } from './shared.js';

const OFFSCREEN_PATH = 'offscreen.html';

let creatingPlaybackHost: Promise<void> | null = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.type === PAGE_COMMAND.CAPTURE ||
    message?.type === PAGE_COMMAND.FOCUS_SOURCE ||
    message?.type === PAGE_COMMAND.CLEAR_SOURCE_FOCUS
  ) {
    void forwardPageCommand(message).then(
      (response) => sendResponse(response),
      (error) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (message?.type === RUNTIME_MESSAGE.PLAYBACK_STATE) {
    void updateAction(message.state);
    return;
  }
  if (message?.type !== RUNTIME_MESSAGE.ENSURE_PLAYBACK_HOST) return;
  void ensurePlaybackHost().then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: String(error) }),
  );
  return true;
});

async function forwardPageCommand(message: { tabId?: unknown }): Promise<unknown> {
  if (typeof message.tabId !== 'number') throw new Error('The source tab is unavailable.');
  return chrome.tabs.sendMessage(message.tabId, message);
}

async function updateAction(state: Pick<PlaybackSnapshot, 'phase' | 'session'>): Promise<void> {
  const stale = Boolean(state.session?.stale);
  const playing = state.phase === 'playing';
  const preparing = state.phase === 'generating';
  const badge = stale ? '!' : playing ? '▶' : preparing ? '…' : '';
  await chrome.action.setBadgeText({ text: badge });
  if (badge) {
    await chrome.action.setBadgeBackgroundColor({ color: stale ? '#b65c42' : '#293865' });
  }
  await chrome.action.setTitle({
    title: stale
      ? 'hey read this page — the source page changed'
      : playing
        ? 'hey read this page — reading'
        : preparing
          ? 'hey read this page — preparing speech'
          : 'Open hey read this page',
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  void chrome.runtime
    .sendMessage({
      target: PLAYBACK_TARGET,
      action: PLAYBACK_ACTION.MARK_STALE,
      tabId,
      url: changeInfo.url,
    })
    .catch(() => {});
});

async function ensurePlaybackHost(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [documentUrl],
  });
  if (contexts.length > 0) return;
  if (!creatingPlaybackHost) {
    creatingPlaybackHost = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['AUDIO_PLAYBACK', 'WORKERS', 'BLOBS'],
        justification: 'Run local speech synthesis and audio playback after the popup closes.',
      })
      .finally(() => {
        creatingPlaybackHost = null;
      });
  }
  await creatingPlaybackHost;
}
