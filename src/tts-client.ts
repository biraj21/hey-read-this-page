import type { SupertonicVoiceId } from './supertonic.js';

export interface AudioResult {
  samples: Float32Array;
  sampleRate: number;
}

type WorkerEvent =
  | { type: 'status'; stage: string; progress: number; message: string }
  | { type: 'ready' }
  | { type: 'audio'; id: number; samples: ArrayBuffer; sampleRate: number }
  | { type: 'error'; id?: number; message: string };

export class TtsClient {
  private readonly worker = new Worker(new URL('./tts-worker.ts', import.meta.url), { type: 'module' });
  private readonly player = createBrowserAudioPlayer();
  private readonly pending = new Map<number, PendingGeneration>();
  private nextId = 1;
  private ready: Promise<void> | null = null;

  constructor() {
    this.worker.addEventListener('message', (event: MessageEvent<WorkerEvent>) =>
      this.handleEvent(event.data),
    );
  }

  initialize(onStatus: (event: Extract<WorkerEvent, { type: 'status' }>) => void): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const initialHandler = (event: MessageEvent<WorkerEvent>) => {
        if (event.data.type === 'status') onStatus(event.data);
        if (event.data.type === 'ready') {
          this.worker.removeEventListener('message', initialHandler);
          resolve();
        }
        if (event.data.type === 'error') {
          this.worker.removeEventListener('message', initialHandler);
          reject(new Error(event.data.message));
        }
      };
      this.worker.addEventListener('message', initialHandler);
      this.worker.postMessage({
        type: 'initialize',
        modelDirectory: chrome.runtime.getURL('onnx'),
        voiceStylesDirectory: chrome.runtime.getURL('voice_styles'),
      });
    });
    return this.ready;
  }

  generate(text: string, voice: SupertonicVoiceId, speed: number): Promise<AudioResult> {
    const id = this.nextId++;
    return new Promise<AudioResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'generate', id, text, voice, speed });
    });
  }

  cancelGeneration(): void {
    for (const [id, pending] of this.pending) {
      this.worker.postMessage({ type: 'cancel', id });
      pending.reject(new GenerationCancelledError());
    }
    this.pending.clear();
  }

  play(audio: AudioResult): Promise<void> {
    return this.player.play(audio.samples, audio.sampleRate);
  }

  stopSpeaking(): Promise<void> {
    return this.player.stop();
  }

  pauseSpeaking(): Promise<boolean> {
    return this.player.pause();
  }

  resumeSpeaking(): Promise<boolean> {
    return this.player.resume();
  }

  private handleEvent(event: WorkerEvent): void {
    if (event.type === 'audio') {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id);
      pending.resolve({ samples: new Float32Array(event.samples), sampleRate: event.sampleRate });
    }
    if (event.type === 'error' && event.id !== undefined) {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id);
      pending.reject(new Error(event.message));
    }
  }
}

type PendingGeneration = {
  resolve: (audio: AudioResult) => void;
  reject: (error: Error) => void;
};

class GenerationCancelledError extends Error {
  constructor() {
    super('Speech generation was cancelled.');
  }
}

function createBrowserAudioPlayer(): {
  play(samples: Float32Array, sampleRate: number): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<boolean>;
  resume(): Promise<boolean>;
} {
  let current: Playback | null = null;

  const finish = (playback: Playback, error?: Error) => {
    if (current !== playback || playback.finished) return;
    playback.finished = true;
    current = null;
    URL.revokeObjectURL(playback.url);
    error ? playback.reject(error) : playback.resolve();
  };

  return {
    async play(samples, sampleRate) {
      await this.stop();
      const url = URL.createObjectURL(new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' }));
      const audio = new Audio(url);
      return new Promise<void>((resolve, reject) => {
        const playback: Playback = { audio, url, resolve, reject, paused: false, finished: false };
        current = playback;
        audio.onended = () => finish(playback);
        audio.onerror = () => finish(playback, new Error('Browser audio playback failed.'));
        audio.play().catch((error: unknown) => {
          if (!playback.paused)
            finish(playback, error instanceof Error ? error : new Error('Audio playback failed.'));
        });
      });
    },
    async stop() {
      if (!current) return;
      current.audio.pause();
      current.audio.currentTime = 0;
      finish(current);
    },
    async pause() {
      if (!current || current.audio.ended) return false;
      current.paused = true;
      current.audio.pause();
      return true;
    },
    async resume() {
      if (!current || current.audio.ended) return false;
      current.paused = false;
      try {
        await current.audio.play();
        return true;
      } catch (error) {
        finish(current, error instanceof Error ? error : new Error('Audio playback failed.'));
        return false;
      }
    },
  };
}

type Playback = {
  audio: HTMLAudioElement;
  url: string;
  resolve: () => void;
  reject: (error: Error) => void;
  paused: boolean;
  finished: boolean;
};

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 4);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 4, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 4, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(44 + index * 4, samples[index], true);
  }
  return buffer;
}
