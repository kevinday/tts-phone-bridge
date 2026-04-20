# TTS Phone Bridge

A minimal PWA that turns typed text into the user's voice-cloned speech, routed to a specific audio output — the line that feeds a phone's mic input through the hardware rig documented in `CLAUDE.md`.

Designed for an ALS patient who can type fluently but can no longer speak, so they can participate in normal phone calls on Android.

## How the patient uses it

1. Open the app URL in Edge on Windows.
2. Click **Install app** in the address bar — it becomes a desktop icon.
3. Double-click the icon on call day; the app opens in its own window.
4. Type; press **Enter** to speak; press **Esc** to cancel.

## Developer setup (Mac)

```bash
npm install
npm run dev
```

Then walk the 4-step setup wizard:
1. Paste ElevenLabs API key → **Test connection**
2. Pick the voice clone → **Preview**
3. Pick the output device plugged into the phone cable → **Play test tone**
4. End-to-end test — record on the phone, verify playback

## Updates

```bash
git push origin main   # GitHub Actions builds + deploys in ~60s
```

The patient's installed PWA detects the new service worker on next open and shows an "Update available — Reload" banner.

## Architecture notes

| Choice | Why |
|---|---|
| Hosted PWA, not native | No admin rights needed on work machines; no code signing; updates = refresh |
| Direct WebSocket client, not official SDK | Browser-friendly, smaller bundle, fewer surprises |
| PCM 16 kHz output from ElevenLabs | Individually decodable chunks, no MP3 frame alignment issues, trivial scheduling |
| `eleven_flash_v2_5` model | ~75ms TTFB; quality is fine for phone audio |
| localStorage for API key | Single-user dedicated device; simplest working option. Don't use on shared machines. |
| `AudioContext.setSinkId` | Chromium-only; patient uses Edge so this is the primary path. Firefox/Safari get fallback UI via `enumerateDevices`. |

## Configuration

- `vite.config.ts` — change `BASE` if the repo name or hosting path changes.
- `src/lib/elevenlabs.ts` — `MODEL_ID` and `OUTPUT_FORMAT` live here.

## Not yet supported (v2 backlog)

- **Hear-yourself monitor** — requires OS virtual audio device (BlackHole/VB-CABLE).
- **Quick phrases** library for common utterances.
- **Repeat last** shortcut.
- **Token broker** — move the API key server-side if ever deployed on a shared machine.
