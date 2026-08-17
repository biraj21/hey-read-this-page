import type {
  PlaybackRequest,
  PlaybackResponse,
  PlaybackSnapshot,
  ReaderBlock,
} from './playback-protocol.js';
import { PAGE_COMMAND, PLAYBACK_ACTION, RUNTIME_MESSAGE } from './shared.js';
import type { SupertonicVoiceId } from './supertonic.js';
import { type AudioResult, TtsClient } from './tts-client.js';

type Session = {
  tabId: number;
  url: string;
  title: string;
  blocks: ReaderBlock[];
  currentIndex: number;
  currentStartOffset: number;
  stale: boolean;
  restartOnResume: boolean;
  cacheId: number;
};

let client: TtsClient | null = null;
let clientPromise: Promise<TtsClient> | null = null;
let session: Session | null = null;
let phase: PlaybackSnapshot['phase'] = 'idle';
let voice: SupertonicVoiceId = 'F1';
let speed = 1.05;
let message = 'Ready to read this tab.';
let runId = 0;
let nextCacheId = 0;
const audioCache = new Map<string, AudioResult>();
const pendingAudio = new Map<string, Promise<AudioResult>>();
const MAX_CACHED_CLIPS = 3;

chrome.runtime.onMessage.addListener((request: PlaybackRequest, _sender, sendResponse) => {
  if (request?.target !== 'playback') return;
  void handle(request).then(
    () => sendResponse({ ok: true, state: snapshot() } satisfies PlaybackResponse),
    (error) => sendResponse({ ok: false, error: readableError(error) } satisfies PlaybackResponse),
  );
  return true;
});

async function handle(request: PlaybackRequest): Promise<void> {
  switch (request.action) {
    case PLAYBACK_ACTION.GET_STATE:
      return;
    case PLAYBACK_ACTION.START:
      voice = request.voice;
      speed = request.speed;
      session = {
        tabId: request.tabId,
        url: request.url,
        title: request.title,
        blocks: request.blocks,
        currentIndex: request.startIndex,
        currentStartOffset: request.startOffset,
        stale: false,
        restartOnResume: false,
        cacheId: ++nextCacheId,
      };
      await interrupt();
      await clearSourceHighlight();
      audioCache.clear();
      void readFrom(request.startIndex, request.startOffset);
      return;
    case PLAYBACK_ACTION.PLAY_FROM:
      if (!session?.blocks[request.index]) return;
      await interrupt();
      await clearSourceHighlight();
      void readFrom(request.index);
      return;
    case PLAYBACK_ACTION.TOGGLE:
      await toggle();
      return;
    case PLAYBACK_ACTION.STOP:
      await interrupt();
      await clearSourceHighlight();
      phase = 'idle';
      message = 'Stopped.';
      publish();
      return;
    case PLAYBACK_ACTION.SET_SETTINGS:
      await updateSettings(request.voice, request.speed);
      return;
    case PLAYBACK_ACTION.MARK_STALE:
      if (session && session.tabId === request.tabId && session.url !== request.url) {
        session.stale = true;
        publish();
      }
  }
}

async function ensureClient(): Promise<TtsClient> {
  if (client) return client;
  if (!clientPromise) {
    clientPromise = Promise.resolve(new TtsClient())
      .then(async (created) => {
        await created.initialize(() => {});
        client = created;
        return created;
      })
      .finally(() => {
        clientPromise = null;
      });
  }
  return clientPromise;
}

async function readFrom(index: number, startOffset = 0): Promise<void> {
  if (!session?.blocks[index]) return;
  const id = ++runId;
  session.restartOnResume = false;
  session.currentIndex = index;
  session.currentStartOffset = startOffset;
  phase = 'generating';
  message = `Preparing paragraph ${index + 1} of ${session.blocks.length}…`;
  publish();
  try {
    const engine = await ensureClient();
    if (id !== runId || !session) return;
    for (let cursor = index; cursor < session.blocks.length; cursor += 1) {
      if (id !== runId || !session) return;
      session.currentIndex = cursor;
      session.currentStartOffset = cursor === index ? startOffset : 0;
      phase = 'generating';
      message = `Preparing paragraph ${cursor + 1} of ${session.blocks.length}…`;
      publish();
      const text = normalizeSpeechText(session.blocks[cursor].text.slice(session.currentStartOffset));
      if (!text) continue;
      const audio = await generateOrReuse(engine, cursor, session.currentStartOffset, text);
      if (id !== runId || !session) return;
      phase = 'playing';
      message = `Reading paragraph ${cursor + 1} of ${session.blocks.length}`;
      publish();
      await focusSourceElement(session.tabId, session.blocks[cursor].sourceElementIds);
      const playback = engine.play(audio);
      prefetchNextParagraph(engine, cursor + 1);
      await playback;
    }
    if (id === runId) {
      phase = 'finished';
      message = 'That’s the end of this reading queue.';
      await clearSourceHighlight();
      publish();
    }
  } catch (error) {
    if (id !== runId) return;
    phase = 'error';
    message = readableError(error);
    await clearSourceHighlight();
    publish();
  }
}

async function toggle(): Promise<void> {
  if (!session) return;
  if (phase === 'paused') {
    if (session.restartOnResume) {
      void readFrom(session.currentIndex, session.currentStartOffset);
      return;
    }
    if (await client?.resumeSpeaking()) {
      phase = 'playing';
      message = `Reading paragraph ${session.currentIndex + 1} of ${session.blocks.length}`;
      publish();
    }
    return;
  }
  if (phase === 'generating') {
    await interrupt();
    session.restartOnResume = true;
    phase = 'paused';
    message = 'Paused while preparing speech.';
    publish();
    return;
  }
  if (phase === 'playing' && (await client?.pauseSpeaking())) {
    phase = 'paused';
    message = `Paused at paragraph ${session.currentIndex + 1} of ${session.blocks.length}.`;
    publish();
  }
}

async function updateSettings(nextVoice: SupertonicVoiceId, nextSpeed: number): Promise<void> {
  voice = nextVoice;
  speed = nextSpeed;
  audioCache.clear();
  if (!session || phase === 'idle' || phase === 'finished' || phase === 'error') {
    message = 'Settings saved for the next paragraph.';
    publish();
    return;
  }
  const { currentIndex, currentStartOffset } = session;
  const wasPaused = phase === 'paused';
  await interrupt();
  if (wasPaused) {
    session.restartOnResume = true;
    phase = 'paused';
    message = 'Resume to restart this paragraph with the new settings.';
    publish();
    return;
  }
  void readFrom(currentIndex, currentStartOffset);
}

async function interrupt(): Promise<void> {
  runId += 1;
  pendingAudio.clear();
  client?.cancelGeneration();
  await client?.stopSpeaking();
}

function generateOrReuse(
  engine: TtsClient,
  index: number,
  startOffset: number,
  text: string,
): Promise<AudioResult> {
  const key = audioCacheKey(index, startOffset, text);
  const cached = audioCache.get(key);
  if (cached) {
    // Refresh its LRU position so a replay remains among the three retained clips.
    audioCache.delete(key);
    audioCache.set(key, cached);
    return Promise.resolve(cached);
  }

  const existing = pendingAudio.get(key);
  if (existing) return existing;

  const generated = engine.generate(text, voice, speed).then((audio) => {
    cacheAudio(key, audio);
    return audio;
  });
  pendingAudio.set(key, generated);
  void generated
    .finally(() => {
      if (pendingAudio.get(key) === generated) pendingAudio.delete(key);
    })
    .catch(() => {});
  return generated;
}

function prefetchNextParagraph(engine: TtsClient, index: number): void {
  if (!session?.blocks[index]) return;
  const text = normalizeSpeechText(session.blocks[index].text);
  if (!text) return;
  // The promise is intentionally left running while audio plays. Errors are
  // handled by the foreground request or discarded when playback is interrupted.
  void generateOrReuse(engine, index, 0, text).catch(() => {});
}

function cacheAudio(key: string, audio: AudioResult): void {
  audioCache.delete(key);
  audioCache.set(key, audio);
  while (audioCache.size > MAX_CACHED_CLIPS) {
    const oldest = audioCache.keys().next().value;
    if (!oldest) return;
    audioCache.delete(oldest);
  }
}

function audioCacheKey(index: number, startOffset: number, text: string): string {
  return `${session?.cacheId ?? 0}:${index}:${startOffset}:${voice}:${speed}:${text}`;
}

function snapshot(): PlaybackSnapshot {
  return {
    phase,
    voice,
    speed,
    session: session
      ? {
          tabId: session.tabId,
          url: session.url,
          title: session.title,
          blocks: session.blocks.map(({ preview }) => ({ preview })),
          currentIndex: session.currentIndex,
          stale: session.stale,
        }
      : null,
    message,
  };
}

function publish(): void {
  void chrome.runtime
    .sendMessage({ type: RUNTIME_MESSAGE.PLAYBACK_STATE, state: snapshot() })
    .catch(() => {});
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message && message !== '[object Object]'
    ? message
    : 'The local voice engine could not read this passage.';
}

function normalizeSpeechText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function focusSourceElement(tabId: number, sourceElementIds: string[] | undefined): Promise<void> {
  await sendPageCommand({ type: PAGE_COMMAND.FOCUS_SOURCE, tabId, sourceElementIds });
}

async function clearSourceHighlight(): Promise<void> {
  if (!session) return;
  await sendPageCommand({ type: PAGE_COMMAND.CLEAR_SOURCE_FOCUS, tabId: session.tabId });
}

async function sendPageCommand(command: Record<string, unknown>): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage(command);
    if (!response?.ok) throw new Error(response?.error || 'The source page is no longer available.');
  } catch {
    // The source tab may have navigated or be a browser page where scripts cannot run.
  }
}
