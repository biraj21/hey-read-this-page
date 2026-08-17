import type { PLAYBACK_ACTION, PLAYBACK_TARGET } from './shared.js';
import type { SupertonicVoiceId } from './supertonic.js';

export type ReaderBlock = { text: string; preview: string; sourceElementIds?: string[] };
export type PlaybackPhase = 'idle' | 'generating' | 'playing' | 'paused' | 'finished' | 'error';

export type PlaybackSnapshot = {
  phase: PlaybackPhase;
  voice: SupertonicVoiceId;
  speed: number;
  session: {
    tabId: number;
    url: string;
    title: string;
    blocks: Array<Pick<ReaderBlock, 'preview'>>;
    currentIndex: number;
    stale: boolean;
  } | null;
  message: string;
};

export type PlaybackRequest =
  | { target: typeof PLAYBACK_TARGET; action: typeof PLAYBACK_ACTION.GET_STATE }
  | {
      target: typeof PLAYBACK_TARGET;
      action: typeof PLAYBACK_ACTION.START;
      tabId: number;
      url: string;
      title: string;
      blocks: ReaderBlock[];
      startIndex: number;
      startOffset: number;
      voice: SupertonicVoiceId;
      speed: number;
    }
  | { target: typeof PLAYBACK_TARGET; action: typeof PLAYBACK_ACTION.PLAY_FROM; index: number }
  | { target: typeof PLAYBACK_TARGET; action: typeof PLAYBACK_ACTION.TOGGLE }
  | { target: typeof PLAYBACK_TARGET; action: typeof PLAYBACK_ACTION.STOP }
  | {
      target: typeof PLAYBACK_TARGET;
      action: typeof PLAYBACK_ACTION.SET_SETTINGS;
      voice: SupertonicVoiceId;
      speed: number;
    }
  | {
      target: typeof PLAYBACK_TARGET;
      action: typeof PLAYBACK_ACTION.MARK_STALE;
      tabId: number;
      url: string;
    };

export type PlaybackResponse = { ok: true; state: PlaybackSnapshot } | { ok: false; error: string };
