import * as ort from 'onnxruntime-web';
import ortJsepFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import ortJsepWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import { loadTextToSpeech, loadVoiceStyle } from './supertonic-v3.js';

const VOICE_IDS = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'] as const;
// Five steps is the project’s fast, high-quality setting; the official model
// supports 5–12, and the GPU backend makes it practical for page reading.
const READER_INFERENCE_STEPS = 5;
const DEFAULT_SPEED = 1.05;

export type SupertonicVoiceId = (typeof VOICE_IDS)[number];

export type SupertonicAudio = {
  audio: Float32Array;
  sampling_rate: number;
};

type TextToSpeech = {
  sampleRate: number;
  call: (
    text: string,
    language: string,
    style: unknown,
    totalSteps: number,
    speed: number,
    silenceDuration: number,
  ) => Promise<{ wav: number[]; duration: number[] }>;
};

type Engine = { textToSpeech: TextToSpeech; backend: 'webgpu' | 'wasm' };
export type SupertonicAssetUrls = { modelDirectory: string; voiceStylesDirectory: string };

let enginePromise: Promise<Engine> | null = null;
let assetUrls: SupertonicAssetUrls | null = null;
const voiceStyles = new Map<SupertonicVoiceId, Promise<unknown>>();

export function isSupertonicVoiceId(value: unknown): value is SupertonicVoiceId {
  return typeof value === 'string' && (VOICE_IDS as readonly string[]).includes(value);
}

export async function loadSupertonic(
  onProgress: (info: unknown) => void,
  nextAssetUrls: SupertonicAssetUrls,
): Promise<void> {
  assetUrls ??= nextAssetUrls;
  await Promise.all([loadEngine(onProgress), loadVoiceStyleFor('F1')]);
}

export async function generateSupertonic(
  text: string,
  voice: SupertonicVoiceId,
  speed: number,
): Promise<SupertonicAudio> {
  const [engine, style] = await Promise.all([loadEngine(() => {}), loadVoiceStyleFor(voice)]);
  const boundedSpeed = Math.min(2, Math.max(0.7, speed));
  console.log('[Local Listen] Supertonic 3 inference input', {
    text,
    voice,
    speed: boundedSpeed,
    inferenceSteps: READER_INFERENCE_STEPS,
    backend: engine.backend,
  });
  const result = await engine.textToSpeech.call(
    text,
    'en',
    style,
    READER_INFERENCE_STEPS,
    boundedSpeed || DEFAULT_SPEED,
    0.3,
  );
  const estimatedLength = Math.floor(engine.textToSpeech.sampleRate * result.duration[0]);
  return {
    audio: Float32Array.from(result.wav.slice(0, estimatedLength)),
    sampling_rate: engine.textToSpeech.sampleRate,
  };
}

async function loadEngine(onProgress: (info: unknown) => void): Promise<Engine> {
  enginePromise ??= createEngine(onProgress);
  return enginePromise;
}

async function createEngine(onProgress: (info: unknown) => void): Promise<Engine> {
  // MV3 CSP forbids the blob workers used by ORT's threaded WASM mode. Supplying
  // packaged runtime files and disabling the worker keeps the fallback extension-safe.
  // WebGPU requires ORT's JSEP factory and matching JSEP binary. Pairing the
  // normal asyncify factory with this binary made ORT reject the WebGPU backend.
  ort.env.wasm.wasmPaths = { mjs: ortJsepFactoryUrl, wasm: ortJsepWasmUrl };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const modelDirectory = requiredAssetUrls().modelDirectory;

  if ('gpu' in navigator) {
    try {
      onProgress({ stage: 'models', completed: 0, total: 4, backend: 'webgpu' });
      const loaded = await loadTextToSpeech(
        modelDirectory,
        { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' },
        (name: string, completed: number, total: number) =>
          onProgress({ stage: 'models', name, completed, total, backend: 'webgpu' }),
      );
      return { textToSpeech: loaded.textToSpeech as TextToSpeech, backend: 'webgpu' };
    } catch (error) {
      console.warn('[Local Listen] Supertonic 3 WebGPU initialization failed; using WASM.', error);
    }
  }

  onProgress({ stage: 'models', completed: 0, total: 4, backend: 'wasm' });
  const loaded = await loadTextToSpeech(
    modelDirectory,
    { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
    (name: string, completed: number, total: number) =>
      onProgress({ stage: 'models', name, completed, total, backend: 'wasm' }),
  );
  return { textToSpeech: loaded.textToSpeech as TextToSpeech, backend: 'wasm' };
}

function loadVoiceStyleFor(voice: SupertonicVoiceId): Promise<unknown> {
  let style = voiceStyles.get(voice);
  if (!style) {
    style = loadVoiceStyle([`${requiredAssetUrls().voiceStylesDirectory}/${voice}.json`]);
    voiceStyles.set(voice, style);
  }
  return style;
}

function requiredAssetUrls(): SupertonicAssetUrls {
  if (!assetUrls) throw new Error('Supertonic 3 assets have not been configured.');
  return assetUrls;
}
