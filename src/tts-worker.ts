import {
  generateSupertonic,
  loadSupertonic,
  type SupertonicAssetUrls,
  type SupertonicVoiceId,
} from './supertonic.js';

type WorkerRequest =
  | ({ type: 'initialize' } & SupertonicAssetUrls)
  | { type: 'generate'; id: number; text: string; voice: SupertonicVoiceId; speed: number }
  | { type: 'cancel'; id: number };

let ready = false;
const cancelled = new Set<number>();

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data);
});

async function handle(request: WorkerRequest): Promise<void> {
  try {
    if (request.type === 'initialize') {
      postMessage({
        type: 'status',
        stage: 'loading',
        progress: 0,
        message: 'Preparing Supertonic 3 on this device…',
      });
      const progress = createProgressReporter();
      await loadSupertonic(progress.update, request);
      ready = true;
      postMessage({ type: 'ready' });
      return;
    }

    if (request.type === 'cancel') {
      cancelled.add(request.id);
      return;
    }

    if (!ready) throw new Error('The Supertonic voice engine is not ready.');
    const audio = await generateSupertonic(request.text, request.voice, request.speed);
    if (cancelled.delete(request.id)) return;
    postMessage(
      { type: 'audio', id: request.id, samples: audio.audio.buffer, sampleRate: audio.sampling_rate },
      [audio.audio.buffer],
    );
  } catch (error) {
    postMessage({
      type: 'error',
      id: request.type === 'generate' ? request.id : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function createProgressReporter(): { update: (info: unknown) => void } {
  let progress = 0;
  const files = new Map<string, { loaded: number; total: number }>();

  const update = (info: unknown) => {
    if (isModelLoadProgress(info)) {
      progress = Math.max(progress, info.completed / info.total);
      postMessage({
        type: 'status',
        stage: 'loading',
        progress,
        message: `Loading Supertonic 3 ${info.name || 'models'}… ${Math.round(progress * 100)}%`,
      });
      return;
    }
    const value = asProgressInfo(info);
    if (value.status === 'ready') {
      postMessage({
        type: 'status',
        stage: 'compile',
        progress: 1,
        message: 'Optimizing Supertonic for your GPU…',
      });
      return;
    }
    if (value.status === 'progress' && value.file && value.total > 0) {
      files.set(value.file, { loaded: value.loaded, total: value.total });
      const totals = [...files.values()].reduce(
        (sum, file) => ({ loaded: sum.loaded + file.loaded, total: sum.total + file.total }),
        { loaded: 0, total: 0 },
      );
      progress = Math.max(progress, totals.loaded / totals.total);
    }
    postMessage({
      type: 'status',
      stage: value.status || 'loading',
      progress,
      message:
        progress > 0
          ? `Downloading the one-time local voice model… ${Math.round(progress * 100)}%`
          : 'Checking the on-device Supertonic cache…',
    });
  };

  return { update };
}

function isModelLoadProgress(info: unknown): info is { name?: string; completed: number; total: number } {
  if (!info || typeof info !== 'object') return false;
  const value = info as Record<string, unknown>;
  return typeof value.completed === 'number' && typeof value.total === 'number' && value.total > 0;
}

function asProgressInfo(info: unknown): { status: string; file: string; loaded: number; total: number } {
  if (!info || typeof info !== 'object') return { status: '', file: '', loaded: 0, total: 0 };
  const value = info as Record<string, unknown>;
  return {
    status: typeof value.status === 'string' ? value.status : '',
    file: typeof value.file === 'string' ? value.file : '',
    loaded: typeof value.loaded === 'number' ? value.loaded : 0,
    total: typeof value.total === 'number' ? value.total : 0,
  };
}
