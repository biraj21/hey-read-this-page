import './style.css';
import type { PlaybackRequest, PlaybackResponse, PlaybackSnapshot } from './playback-protocol.js';
import { PAGE_COMMAND, PLAYBACK_ACTION, PLAYBACK_TARGET, RUNTIME_MESSAGE } from './shared.js';
import { isSupertonicVoiceId, type SupertonicVoiceId } from './supertonic.js';

type ActiveTab = { id: number; url: string; title: string };

const voices: Array<{ id: SupertonicVoiceId; label: string }> = [
  { id: 'F1', label: 'Female · F1' },
  { id: 'F2', label: 'Female · F2' },
  { id: 'F3', label: 'Female · F3' },
  { id: 'F4', label: 'Female · F4' },
  { id: 'F5', label: 'Female · F5' },
  { id: 'M1', label: 'Male · M1' },
  { id: 'M2', label: 'Male · M2' },
  { id: 'M3', label: 'Male · M3' },
  { id: 'M4', label: 'Male · M4' },
  { id: 'M5', label: 'Male · M5' },
];

const app = getAppRoot();
let lastQueueKey: string | null = null;
const state: {
  activeTab: ActiveTab | null;
  playback: PlaybackSnapshot;
  voice: SupertonicVoiceId;
  speed: number;
  capturing: boolean;
  error: string | null;
} = {
  activeTab: null,
  playback: emptyPlayback(),
  voice: 'F1',
  speed: 1.05,
  capturing: false,
  error: null,
};

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'read-active') void readActiveTab();
  if (action === 'toggle') void togglePlayback();
  if (action === 'play-from')
    void sendPlayback({ action: PLAYBACK_ACTION.PLAY_FROM, index: Number(target.dataset.index) });
  if (action === 'open-playing-tab') void openPlayingTab();
});

app.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  if (input.id === 'voice') state.voice = input.value as SupertonicVoiceId;
  if (input.id === 'speed') state.speed = Number(input.value);
  void savePreferencesAndApply();
  render();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== RUNTIME_MESSAGE.PLAYBACK_STATE) return;
  const previousPlayback = state.playback;
  const nextPlayback = message.state as PlaybackSnapshot;
  state.playback = nextPlayback;
  if (state.playback.session) {
    state.voice = state.playback.voice;
    state.speed = state.playback.speed;
  }
  render();
  if (hasStartedSpeaking(nextPlayback, previousPlayback)) scrollCurrentParagraphIntoView();
});

chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.url) void refreshActiveTab();
});

void initialise();

async function initialise(): Promise<void> {
  const preferences = await chrome.storage.local.get({ voice: 'F1', speed: 1.05 });
  state.voice = savedVoice(preferences.voice);
  state.speed = validSpeed(preferences.speed) ? preferences.speed : 1.05;
  await refreshActiveTab();
  await ensurePlaybackHost();
  state.playback = await requestPlayback({ action: PLAYBACK_ACTION.GET_STATE });
  if (state.playback.session) {
    state.voice = state.playback.voice;
    state.speed = state.playback.speed;
  }
  render();
  if (state.playback.phase === 'playing') scrollCurrentParagraphIntoView();
}

async function refreshActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.activeTab =
    tab?.id && tab.url ? { id: tab.id, url: tab.url, title: tab.title || 'Untitled page' } : null;
  render();
}

async function readActiveTab(): Promise<void> {
  const tab = state.activeTab;
  if (!tab) return;
  state.capturing = true;
  state.error = null;
  render();
  try {
    await sendPlayback({ action: PLAYBACK_ACTION.STOP });
    const capture = await chrome.runtime.sendMessage({ type: PAGE_COMMAND.CAPTURE, tabId: tab.id });
    if (!capture?.ok) throw new Error(capture?.error || 'Could not read the page content.');
    const page = capture.page;
    if (!page?.blocks.length) throw new Error('No readable text was found on this page.');
    await sendPlayback({
      action: PLAYBACK_ACTION.START,
      tabId: tab.id,
      url: page.url,
      title: page.title,
      blocks: page.blocks,
      startIndex: page.startIndex,
      startOffset: page.startOffset,
      voice: state.voice,
      speed: state.speed,
    });
  } catch (error) {
    state.error = readableError(error);
  } finally {
    state.capturing = false;
    render();
  }
}

async function togglePlayback(): Promise<void> {
  if (!state.playback.session) return;
  if (
    state.playback.phase === 'playing' ||
    state.playback.phase === 'paused' ||
    state.playback.phase === 'generating'
  ) {
    await sendPlayback({ action: PLAYBACK_ACTION.TOGGLE });
    return;
  }
  await sendPlayback({ action: PLAYBACK_ACTION.PLAY_FROM, index: state.playback.session.currentIndex });
}

async function openPlayingTab(): Promise<void> {
  const tabId = state.playback.session?.tabId;
  if (!tabId) return;
  state.error = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    state.error = readableError(error) || 'The tab for this reading is no longer available.';
    render();
  }
}

async function savePreferencesAndApply(): Promise<void> {
  await chrome.storage.local.set({ voice: state.voice, speed: state.speed });
  if (state.playback.session) {
    await sendPlayback({ action: PLAYBACK_ACTION.SET_SETTINGS, voice: state.voice, speed: state.speed });
  }
}

async function sendPlayback(request: Omit<PlaybackRequest, 'target'>): Promise<void> {
  try {
    state.playback = await requestPlayback(request);
    state.error = null;
  } catch (error) {
    state.error = readableError(error);
  }
  render();
}

async function requestPlayback(request: Omit<PlaybackRequest, 'target'>): Promise<PlaybackSnapshot> {
  await ensurePlaybackHost();
  const response = (await chrome.runtime.sendMessage({
    target: PLAYBACK_TARGET,
    ...request,
  })) as PlaybackResponse;
  if (!response?.ok) throw new Error(response?.error || 'The playback engine is unavailable.');
  return response.state;
}

async function ensurePlaybackHost(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: RUNTIME_MESSAGE.ENSURE_PLAYBACK_HOST });
  if (!response?.ok) throw new Error(response?.error || 'Could not start the local playback engine.');
}

function render(): void {
  const playback = state.playback;
  const session = playback.session;
  const previousList = app.querySelector<HTMLElement>('.queue-list');
  const previousScrollTop = previousList?.scrollTop ?? 0;
  const queueKey = session ? `${session.tabId}:${session.url}` : null;
  const isSameQueue = Boolean(queueKey && lastQueueKey === queueKey);
  const isPlaying = playback.phase === 'playing';
  const isPreparing = playback.phase === 'generating';
  const isThisPageQueued = Boolean(session && state.activeTab && session.url === state.activeTab.url);
  const isPlayingElsewhere = Boolean(session && state.activeTab && session.tabId !== state.activeTab.id);
  const status = state.error || playback.message;
  const readingLabel = currentReadingLabel(playback.phase, Boolean(session));
  const readingContext = currentReadingContext(playback.phase, isPlayingElsewhere, Boolean(session));

  app.innerHTML = `
    <main class="player-shell">
      <header class="player-header">
        <span class="brand-mark" aria-hidden="true">⌁</span>
        <div><strong>hey read this page</strong><p>Listen to pages in your browser</p></div>
      </header>

      <section class="now-reading" aria-label="Current reading">
        <p class="eyebrow">${readingLabel}</p>
        <strong>${escapeHtml(session?.title || 'No page in the queue')}</strong>
        <p>${escapeHtml(readingContext)}</p>
        <button class="open-tab-button ${isPlayingElsewhere ? '' : 'is-hidden'}" data-action="open-playing-tab" ${
          isPlayingElsewhere ? '' : 'tabindex="-1" aria-hidden="true"'
        }>Open that tab</button>
      </section>

      ${session ? `<section class="queue" aria-label="Reading queue"><p class="eyebrow">Paragraphs · ${session.currentIndex + 1} of ${session.blocks.length}</p><div class="queue-list">${session.blocks.map((block, index) => `<button class="queue-item ${index === session.currentIndex ? 'current' : ''}" data-action="play-from" data-index="${index}"><span>${String(index + 1).padStart(2, '0')}</span><em>${escapeHtml(block.preview)}</em></button>`).join('')}</div></section>` : `<section class="queue empty-queue"><p class="eyebrow">Reading queue</p><p>Your paragraphs will appear here.</p></section>`}

      <footer class="bottom-controls">
        <p class="status ${state.error ? 'error' : ''}" aria-live="polite">${escapeHtml(status)}</p>
        <div class="transport">
          <button class="read-button" data-action="read-active" title="${
            isThisPageQueued ? 'This page is already in the reading queue.' : 'Read the page in this tab.'
          }" ${state.capturing || isThisPageQueued ? 'disabled' : ''}>${state.capturing ? 'Finding text…' : 'Read this page'}</button>
          <button class="play-button" data-action="toggle" ${session ? '' : 'disabled'}>${isPlaying || isPreparing ? 'Pause' : 'Play'}</button>
        </div>
        <section class="settings">
          <label>Voice<select id="voice">${voices.map((option) => `<option value="${option.id}" ${option.id === state.voice ? 'selected' : ''}>${option.label}</option>`).join('')}</select></label>
          <label>Pace<select id="speed">${[0.7, 0.8, 0.9, 1, 1.05, 1.1, 1.2, 1.4, 1.6, 1.8, 2].map((option) => `<option value="${option}" ${option === state.speed ? 'selected' : ''}>${option.toFixed(option === 1.05 ? 2 : 1)}×</option>`).join('')}</select></label>
        </section>
      </footer>
    </main>`;
  const list = app.querySelector<HTMLElement>('.queue-list');
  if (list && isSameQueue) list.scrollTop = previousScrollTop;
  lastQueueKey = queueKey;
}

function hasStartedSpeaking(next: PlaybackSnapshot, previous: PlaybackSnapshot): boolean {
  return (
    next.phase === 'playing' &&
    (previous.phase !== 'playing' || next.session?.currentIndex !== previous.session?.currentIndex)
  );
}

function scrollCurrentParagraphIntoView(): void {
  requestAnimationFrame(() => {
    const list = app.querySelector<HTMLElement>('.queue-list');
    const current = app.querySelector<HTMLElement>('.queue-item.current');
    if (!list || !current) return;
    scrollIntoView(list, current);
  });
}

function scrollIntoView(container: HTMLElement, element: HTMLElement): void {
  const top =
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    (container.clientHeight - element.offsetHeight) / 2;
  container.scrollTo({
    top: Math.max(0, top),
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}

function emptyPlayback(): PlaybackSnapshot {
  return { phase: 'idle', voice: 'F1', speed: 1.05, session: null, message: 'Ready to read this page.' };
}

function currentReadingLabel(phase: PlaybackSnapshot['phase'], hasSession: boolean): string {
  if (!hasSession) return 'Ready to listen';
  if (phase === 'playing') return 'Now playing';
  if (phase === 'generating') return 'Getting ready to play';
  if (phase === 'paused') return 'Paused on';
  if (phase === 'finished') return 'Finished reading';
  return 'Reading queue';
}

function currentReadingContext(
  phase: PlaybackSnapshot['phase'],
  isPlayingElsewhere: boolean,
  hasSession: boolean,
): string {
  if (!hasSession) return 'Read this page to start listening.';
  const source = isPlayingElsewhere ? 'another tab' : 'this tab';
  if (phase === 'playing') return `Playing from ${source}.`;
  if (phase === 'generating') return `Preparing speech from ${source}.`;
  if (phase === 'paused') return `Paused on ${source}.`;
  if (phase === 'finished') return `The queue from ${source} has finished.`;
  return `This queue was created from ${source}.`;
}

function savedVoice(value: unknown): SupertonicVoiceId {
  if (isSupertonicVoiceId(value)) return value;
  // Preserve the old two-voice preference during the upgrade.
  return value === 'male' ? 'M1' : 'F1';
}

function validSpeed(value: unknown): value is number {
  return typeof value === 'number' && value >= 0.7 && value <= 2;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message && message !== '[object Object]' ? message : 'Something went wrong.';
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] || character,
  );
}

function getAppRoot(): HTMLDivElement {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) throw new Error('hey read this page could not find its app root.');
  return root;
}
