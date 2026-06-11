# TTS Phone Bridge — Complete Project Summary

A detailed record of the project to give an ALS user (who can no longer speak but types fluently) a way to participate in phone calls and video meetings using a synthesized voice clone of his own voice.

## Project goal

The user types on a computer; ElevenLabs synthesizes his voice clone; the synthesized speech is delivered into a phone call (or Teams/Meet meeting) so the other party hears him "speak." The user hears the other party through earbuds.

There are two main scenarios:

1. **Phone calls on Android** — synthesized voice goes into a Pixel phone, caller on the other end hears him through the cellular call.
2. **Microsoft Teams / Google Meet on Windows** — synthesized voice goes into the meeting as the user's microphone source.

## Hardware journey (phone-call setup)

### Hardware purchased early in the project

| Item | Original purpose | Status |
|---|---|---|
| jstma USB-C → 3.5mm TRRS adapter | Give the Android phone an analog headset jack | Working but not used in final setup |
| Kingtop TRRS splitter (1M → 2F) | Split that jack into separate headphone + mic legs | Working but not used in final setup |
| Cubilux attenuator (-10/-20/-30dB switchable) | Drop computer line-level (~1V) down to mic-level (~30mV) | Still in use as a line-to-mic attenuator |
| CableCreation 0.45m 3.5mm aux cable | Spare/extension | Spare |

### The original chain (didn't work for phone calls)

```
Computer headphone-out
        ↓
Cubilux attenuator (-30dB)
        ↓
Kingtop splitter — mic-side jack (pink)
        ↑
   [TRRS male plug]
        ↓
Kingtop splitter — headphone-side jack (green)
        ↑
   White earbuds (user hears caller here)
        ↓
jstma USB-C adapter
        ↓
Android phone
```

### What failed and why

When set up as above, the headphone path worked fine (music playback to earbuds was clear), but the mic path was completely invisible to the Android phone. The phone fell back to its built-in mic for both the voice recorder app and live phone calls. Covering the bottom of the phone (where the built-in mic sits) muffled recordings — that test confirmed the phone was using the internal mic, not the TRRS mic input from the chain.

### Root cause we eventually figured out

Android phones don't blindly accept whatever's on the TRRS mic pin. When a TRRS plug is inserted, the phone runs a **mic detection check**:

1. It applies ~2.2V "mic bias" voltage to the mic pin through a 2.2kΩ resistor.
2. It measures the DC resistance from that pin to ground.
3. If it sees a load in the right range (roughly 1kΩ to 3kΩ, like a real electret microphone capsule), it enables the mic input.
4. If the load is too low or DC-shorted, it concludes "no mic present" and silently falls back to the phone's built-in mic.

A real electret mic naturally presents that ~2.2kΩ load because of the JFET inside the capsule. The Cubilux attenuator does not — it's a passive resistor pad designed for camera/camcorder mic inputs, where there's no detection check. Its internal resistor network presents the wrong impedance and DC-couples straight back to the laptop's headphone amp (very low impedance). When Android probes for a mic, it sees "low impedance / not a mic" and gives up on the headset mic entirely.

This is why output worked perfectly (output is a separate signal path with no detection logic) but the mic was completely invisible.

### Options we considered

1. **DIY fix:** Add a 2.2kΩ resistor + 10µF capacitor inline at the TRRS mic pin to fake the electret load. Cheap (~$5 in parts) but requires soldering.
2. **Headset Buddy Mic-Line:** Purpose-built line-to-smartphone-mic adapter (~$25). Drops in for the Cubilux. Would have meant losing the Kingtop splitter's role and needing a separate solution for the earbuds.
3. **Sescom IPHONE-LN2MIC-1:** Considered briefly. On closer inspection it's architecturally identical to the existing Cubilux+Kingtop combo. We didn't buy it — likely would have had the same detection problem.
4. **USB-C audio interface (Saramonic SR-EA2U):** Skip the analog detection problem entirely by talking to the phone as a USB Audio Class device. The phone sees it as a digital audio device with both input and output, no impedance check involved.

### What we landed on

The **Saramonic SR-EA2U USB-C Audio Interface (~$45)** as a complete replacement for the analog chain to the phone. The Pixel phone treats it as a USB Audio Class device, which routes cellular call audio correctly (this is something Pixels do reliably; Samsung phones do not).

### Final chain (works)

```
Mac/Windows laptop (3.5mm headphone-out)
     ↓
3.5mm cable
     ↓
Cubilux attenuator (-30dB, kept from original setup)
     ↓
SR-EA2U "MIC IN" jack (3.5mm)
     ↓
SR-EA2U "HEADPHONE OUT" jack (3.5mm) → white earbuds (user hears caller)
     ↓
SR-EA2U USB-C plug → Pixel phone USB-C port
```

The jstma adapter and Kingtop splitter are retired (kept as spares).

### Things we learned along the way

- Pixels route cellular call audio through USB audio class devices reliably. Samsungs do not — they restrict call audio to Samsung-approved headsets only. Vendor matters a lot here.
- Many USB-C-to-3.5mm dongles labeled "TRRS" only do output (DAC chip) and silently drop the mic pin. We initially suspected this of the jstma; turned out the actual problem was Android-side detection, not the adapter.
- "App-dependent monitoring" in audio interface marketing means software-only loopback monitoring (e.g., a recording app pipes mic→headphone in software). It is NOT the same as hardware direct monitoring (an analog mixer between mic-in and headphone-out, independent of any software). The SR-EA2U has the former but not the latter.

## Hardware setup for Teams / Google Meet on Windows

The phone-call hardware (SR-EA2U etc.) isn't involved at all for Teams. The solution is purely software via a virtual audio cable.

### Components

- **VB-Cable** ([vb-audio.com/Cable](https://vb-audio.com/Cable/)) — free Windows virtual audio driver. Creates two new audio devices on the system: "CABLE Input (VB-Audio)" and "CABLE Output (VB-Audio)." Audio sent INTO CABLE Input comes OUT of CABLE Output. Like a software wire.
- **VoiceMeeter** ([vb-audio.com/Voicemeeter](https://vb-audio.com/Voicemeeter/)) — free Windows virtual audio mixer. Used for self-monitor (so the user can hear his own synthesized voice during meetings) by routing the TTS output to both the meeting (via CABLE Input) and his headphones simultaneously.

### Workflow

1. In the TTS app, output device → **VoiceMeeter Input** (or **CABLE Input** if not using VoiceMeeter).
2. In VoiceMeeter: A1 → CABLE Input (this is what Teams reads as the mic), A2 → user's headphones.
3. In Teams/Meet/Zoom: microphone → **CABLE Output (VB-Audio)**.

This works for Teams, Google Meet, Zoom, Discord, Slack huddles — any conferencing app that lets you pick a microphone.

## Switching between modes

The user can swap between phone-call mode and Teams/Meet mode just by changing the output device in the TTS app status bar (added during this project — see software section below):

- **Phone calls:** output → SR-EA2U (or VoiceMeeter Input if using the self-monitor mixer)
- **Teams meetings:** output → VoiceMeeter Input (or CABLE Input directly if not using self-monitor)

The TTS app remembers the last selection between sessions.

## Pending: phone-call self-monitor (hardware mixer)

For phone calls, the user can currently hear the caller through the SR-EA2U's headphone-out but can't hear his own synthesized voice. Software can't solve this because the caller's audio physically lives in the SR-EA2U's headphone output, downstream of the phone.

The planned solution is a small hardware mixer that combines:

- The laptop's TTS output (tapped via a Y-splitter)
- The SR-EA2U's headphone output (carrying caller's voice)

…and drives the user's earbuds with the combined signal. See `Self-Monitor Setup Guide.md` for the wiring diagram, parts list, and three mixer recommendations (MX3 Mini Line Mixer, Saramonic AX1, or TENEALAY X21). Total additional cost ~$20–40. Not yet purchased or installed.

## The TTS app (software)

The TTS app is a small React + TypeScript + Vite PWA hosted on GitHub Pages at <https://kevinday.github.io/tts-phone-bridge/>, source in the same project folder.

### Architecture

- React 19 + TypeScript + Vite, deployed as a Progressive Web App.
- ElevenLabs Flash v2.5 model accessed via the WebSocket `stream-input` endpoint. This streams partial audio as soon as the model can generate it, minimizing latency (75ms TTFB target).
- PCM 16kHz output, decoded client-side and played through the Web Audio API.
- Settings persisted in `localStorage` (ElevenLabs API key, voice ID, output device, etc.). Acceptable because this is a dedicated single-user device.
- Output device routing uses `setSinkId` — Chromium-only feature that the patient's Edge browser supports. Firefox/Safari fall back to playing through the default browser output.

### Source layout

```
src/
  main.tsx                — entry
  App.tsx                 — top-level routing between wizard and speak screen
  index.css               — Tailwind v4
  lib/
    elevenlabs.ts         — WebSocket client for stream-input endpoint
    audioPlayer.ts        — PCM scheduler over Web Audio API with setSinkId
    audioOutput.ts        — output device enumeration and picker helpers
    settings.ts           — localStorage wrapper for persisted state
  screens/
    SetupWizard.tsx       — 4-step setup (API key → voice → output → end-to-end test)
    SpeakScreen.tsx       — main typing-and-speaking screen
  components/
    Stepper.tsx           — stepper UI for wizard
    QuickPhrasesEditor.tsx — modal editor for the quick-phrases list
```

### Features that existed before this project's recent work

- 4-step setup wizard.
- Big textarea for typing. Press Enter to send the utterance through Flash v2.5 → audio plays.
- "Auto-send on punctuation" toggle — sentence ending with `.?!` followed by a space automatically commits.
- Quick phrases (Yes / No / Thank you / etc.) as clickable buttons. Editable list.
- Repeat button (re-plays the last utterance).
- Stop button (kills the current stream and any queued utterances).
- Latency display (TTFB in ms — time from press-Enter to first audible audio).
- Volume control inside the wizard.
- Laptop-speakers warning if the output device label looks like internal speakers.

### Features added during this project

#### Output device picker on the main screen

The output device label in the status bar is now clickable. Clicking opens the native Chromium picker (or an inline dropdown on Firefox/Safari). The chosen device persists in localStorage. Letting the user swap between phone-cable output and VoiceMeeter Input (for Teams) without going back through the setup wizard was important — they'll be switching multiple times a day.

#### Voice picker on the main screen

The voice name in the status bar is also clickable. First click lazily fetches the voice list from ElevenLabs (cached for the rest of the session). User can switch voices mid-session.

#### Teams/Meet hint card in the setup wizard

Expandable card at the end of step 4 explaining the VB-Cable + output-device workflow for using the app with Teams/Meet/Zoom. Discoverability help; doesn't change the wizard flow.

#### Speech speed slider

ElevenLabs supports a `speed` parameter in `voice_settings`, range 0.7–1.2 (default 1.0). User reported the synthesized voice was reading too fast. A slider in the status bar now controls this, persisted to localStorage, and only sent to the API when it differs from the default (so when the slider hasn't moved, the wire payload is byte-identical to the previous version).

Double-clicking the slider resets to 1.00×.

### A failed experiment we tried and rolled back: real-time "stream as you type" mode

We attempted to add an experimental real-time mode where text streamed to ElevenLabs as the user typed (rather than waiting for Enter or terminal punctuation). It was feature-flagged off by default with an "experimental" badge.

It almost worked. The architecture was right: a long-lived WebSocket, `chunk_length_schedule` controlling phrase commits, idle timer for auto-flush, abort+restart on backspace, etc. We even added a configurable idle-flush slider.

But the synthesized voice spelled out individual letters ("H E L L O") instead of pronouncing words. Root cause: the existing `send()` function in the WebSocket client auto-appends a trailing space ("server uses trailing whitespace as a hint that more text may follow"). Calling `send(char)` on every keystroke meant each character became its own one-letter "word" on the server side.

We did fix this by adding word-boundary batching: only call `send()` when typed characters cross a word boundary (space, punctuation, newline), so the model only ever sees complete words. The fix worked technically, but the user evaluated the resulting experience and decided it wasn't worth keeping ("real-time mode is a bust"). We removed the whole feature rather than ship it half-baked. All the related code in `SpeakScreen.tsx` and `settings.ts` is gone.

The lesson preserved here: ElevenLabs' streaming API is happy with low-character-count fragments at word boundaries, but you can't send mid-word fragments without confusing the model.

### Deployment

GitHub Pages, via a GitHub Action that builds and deploys on push to `main`. To deploy any change:

```bash
cd "/Users/k_day/Documents/Claude/Projects/text to voice"
git add <files>
git commit -m "..."
git push
```

The PWA shows a "new version available" banner once the service worker detects the update; clicking Reload there picks up the new build cleanly. A hard refresh (Cmd+Shift+R or Ctrl+Shift+R) is the manual escape hatch.

The patient's Windows machine and the user's Mac both push SSH over port 443 (`ssh.github.com:443`) because their network blocked outbound port 22. This is set in `~/.ssh/config`:

```
Host github.com
  Hostname ssh.github.com
  Port 443
  User git
```

## What works (current state, end-to-end)

- **Phone calls on Pixel:** TTS app → Cubilux → SR-EA2U → USB-C → Pixel → cellular call. Caller hears the voice clone clearly. User hears the caller through earbuds plugged into the SR-EA2U's headphone-out. ✓
- **Teams on Windows:** TTS app → VoiceMeeter → CABLE Input → Teams reads CABLE Output. Meeting hears the voice clone. User's headphones (driven by VoiceMeeter A2) also play the TTS, so he hears himself. ✓
- **Voice selection from the main screen:** click voice name, pick from dropdown. ✓
- **Output device selection from the main screen:** click output name, native picker opens. Works for swapping between phone-cable mode and Teams mode. ✓
- **Speech speed control:** slider in status bar, 0.7×–1.2×, double-click to reset. Persists across sessions. ✓
- **Repeat last utterance, quick phrases, auto-send-on-punctuation, Stop:** all still working as they did before. ✓
- **Deployment pipeline:** push to `main` builds and deploys to GitHub Pages within ~1 minute. ✓

## What's not yet done

- **Phone-call self-monitor.** Hardware planned (Y-splitter + small mixer), parts list and wiring documented in `Self-Monitor Setup Guide.md`, but nothing has been bought or wired up yet.
- **Real-time mode.** Tried, rolled back. Not on the roadmap.

## Important caveats and things to remember

- **Patient is on Windows + Pixel 10.** Kevin (the project owner) is on Mac + Pixel 10 Pro XL. Most testing happened on Kevin's Mac first.
- **The SR-EA2U is a Pixel-specific solution as far as we've verified.** Samsung phones likely won't route cellular call audio through it. If the patient ever switches phones, re-test before assuming.
- **The Cubilux attenuator is still in the chain** in front of the SR-EA2U's MIC IN because the laptop's headphone output is line-level (~1V) and the SR-EA2U's mic input is mic-level (~30mV). The Cubilux drops the level appropriately. It's NOT in the chain for any impedance/detection reason — that part was solved by going USB instead of analog-into-the-phone.
- **The earlier hardware (jstma, Kingtop) is retired but kept as spares.** Don't throw it out; could be useful for a quick demo of "the old way" or as a fallback if the SR-EA2U fails.
- **Speech speed at the extremes (0.7× and 1.2×) may degrade audio quality** per ElevenLabs docs. The user found the default too fast; we expect his sweet spot to be somewhere around 0.85–0.95.

## File index

- `CLAUDE.md` — original hardware notes (slightly outdated; reflects the pre-SR-EA2U setup)
- `Self-Monitor Setup Guide.md` — VoiceMeeter for Teams + planned mixer for phone calls
- `Project Summary.md` — this document
- `src/` — TTS app source
- `package.json`, `vite.config.ts`, `tsconfig.*` — build configuration
