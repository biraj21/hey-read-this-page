# Local Listen

A local Chrome page reader powered by Supertonic 3. Text and audio stay on your device.

## Build

```sh
pnpm install
pnpm run install-assets
pnpm build
```

Load `dist` as an unpacked extension in Chrome.

## Flow

```mermaid
sequenceDiagram
      actor User
      participant Popup as Popup<br/>main.ts
      participant BG as Service worker<br/>background.ts
      participant Tab as Current web page
      participant Offscreen as Offscreen host<br/>offscreen.ts
      participant Client as TtsClient
      participant Worker as TTS worker<br/>tts-worker.ts
      participant TTS as Supertonic 3<br/>WebGPU / WASM
      participant Audio as Browser audio

      User->>Popup: Open extension
      Popup->>BG: playback:ensure-host
      BG->>Offscreen: Create offscreen.html if missing
      Popup->>Offscreen: get-state
      Offscreen-->>Popup: Current queue / voice / status

      User->>Popup: Read this page
      Popup->>Tab: scripting.executeScript(captureReadableText)
      Tab-->>Popup: Title + readable blocks + selection position
      Popup->>Offscreen: start(blocks, voice, speed)

      Offscreen->>Client: Initialize once
      Client->>Worker: initialize(asset URLs)
      Worker->>TTS: Load ONNX models + F1 style
      TTS-->>Worker: Ready
      Worker-->>Client: ready

      loop Each paragraph
          Offscreen->>Client: Generate current paragraph
          Client->>Worker: generate(text, voice, speed)
          Worker->>TTS: Infer locally on WebGPU
          TTS-->>Worker: Float32 audio
          Worker-->>Client: Audio buffer
          Offscreen->>Audio: Encode WAV and play

          par While current audio plays
              Offscreen->>Client: Pre-infer next paragraph
          and UI status
              Offscreen-->>Popup: playback:state
              Offscreen-->>BG: playback:state
              BG->>BG: Update badge/title
          end
      end

      User->>Popup: Replay recent paragraph
      Popup->>Offscreen: play-from(index)
      Offscreen->>Offscreen: Reuse one of 3 cached clips, if present
      Offscreen->>Audio: Play immediately
```

## Credits

Uses [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) by [Supertone Inc](https://www.supertone.ai/en).

## License

MIT

```

```
