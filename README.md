# hey read this page

A local Chrome page reader powered by Supertonic 3. Text and audio stay on your device.

> Note: I haven't written nor read a single LOC for this project (yet). I used gpt-5.6-terra high in Codex TUI, but I was still in the loop - tested the entire thing, described ideas, UI/UX, product logic, gave it error logs and feedback, and pretty much abused it until I was satisfied with the result. For inference, I gave it Supertonic 3's GitHub repo as reference.

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
    participant User
    participant Popup
    participant SW as Service Worker
    participant CS as Content Script
    participant DOM as Page DOM
    participant Offscreen as Offscreen Host
    participant Client as TtsClient
    participant Worker as TTS Worker
    participant TTS as Supertonic 3
    participant Audio as Audio Output

    User->>Popup: Open extension
    Popup->>SW: Ensure playback host
    SW->>Offscreen: Create offscreen.html if needed
    Popup->>Offscreen: Get playback state
    Offscreen-->>Popup: Queue, voice, and status

    User->>Popup: Read this page
    Popup->>SW: Request page capture
    SW->>CS: Forward capture request
    CS->>DOM: Parse text and inject source spans
    DOM-->>CS: Title, blocks, selection position
    CS-->>SW: Capture result
    SW-->>Popup: Capture result
    Popup->>Offscreen: Start with blocks voice and speed

    Offscreen->>Client: Initialize once
    Client->>Worker: Initialize with asset URLs
    Worker->>TTS: Load models and voice style
    TTS-->>Worker: Ready
    Worker-->>Client: Ready

    loop Each paragraph
        Offscreen->>Client: Generate current paragraph
        Client->>Worker: Generate audio
        Worker->>TTS: Infer locally
        TTS-->>Worker: Float32 audio
        Worker-->>Client: Audio buffer

        Offscreen->>SW: Focus current source spans
        SW->>CS: Forward focus request
        CS->>DOM: Highlight spans and scroll first span into view
        Offscreen->>Audio: Encode WAV and play

        Offscreen->>Client: Pre-infer next paragraph
        Offscreen-->>Popup: Send playback state
        Offscreen-->>SW: Send playback state
        SW->>SW: Update badge and title
    end

    User->>Popup: Stop or replay a paragraph
    Popup->>Offscreen: Stop or play from index
    Offscreen->>SW: Clear or focus source spans
    SW->>CS: Forward page command
    Offscreen->>Offscreen: Reuse one of 3 cached clips when available
```

Review in this order: `src/main.ts` (UI), `src/background.ts` (routing/lifecycle), `src/content.ts` and `src/page-capture.ts` (page DOM), then `src/offscreen.ts` (queue/playback), `src/tts-client.ts`, and `src/tts-worker.ts` (model execution).

## Credits

Uses [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) by [Supertone Inc](https://www.supertone.ai/en).

## License

MIT
