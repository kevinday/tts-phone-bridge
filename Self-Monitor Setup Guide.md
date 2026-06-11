# TTS Voice Self-Monitor Setup Guide

The user has a TTS voice clone setup with two main use cases:

- **Phone calls** — TTS audio routes through the Saramonic SR-EA2U USB-C audio interface into a Pixel phone. Earbuds plug into the SR-EA2U's headphone jack and carry the caller's voice.
- **Microsoft Teams / Google Meet / Zoom** — TTS audio routes through VB-Cable (a virtual audio device on Windows) into the meeting app's microphone input.

In both cases, the user wants to **hear his own generated voice** through the same earbuds he's wearing during the call/meeting.

This document covers the setup for both scenarios.

## Why the two scenarios need different solutions

The setups differ in where the audio physically lives.

**Teams (and other laptop-based conferencing apps):** Both the outgoing TTS and the incoming caller audio live on the laptop. The user's earbuds plug into the laptop too. So everything is in software-routing range — a virtual audio mixer (VoiceMeeter) can combine both streams in the digital domain before they reach the earbuds.

**Phone:** The caller's audio doesn't exist on the laptop at all. It comes back from the Pixel, through the USB-C cable, and out the SR-EA2U's headphone jack — which is where the earbuds are physically plugged in. The TTS audio leaves the laptop and never re-enters it. Combining the two streams requires them to meet *somewhere physical*. Pure software can't do it; you need a small hardware mixer.

The good news is that one piece of free software (VoiceMeeter) solves the Teams case entirely, and the hardware required for the phone case is small and cheap (~$20–40 of additions to the existing setup).

## Setup A: Teams / Google Meet / Zoom

This works for any conferencing app that lets you pick a microphone (Teams, Google Meet, Zoom, Discord, Slack huddles, etc.).

### Prerequisites (one-time install)

1. Install **VB-Cable** from [vb-audio.com/Cable](https://vb-audio.com/Cable/). Run installer as Administrator.
2. Install **VoiceMeeter** (the basic free version) from [vb-audio.com/Voicemeeter](https://vb-audio.com/Voicemeeter/). Run installer as Administrator.
3. **Reboot the Windows machine.** Both drivers require this to register.

### One-time VoiceMeeter configuration

1. Open VoiceMeeter (search Start for it after the reboot).
2. In the top-right corner, set the hardware-out selectors:
   - **A1** → **CABLE Input (VB-Audio)** — this is what the meeting reads as the microphone source.
   - **A2** → **laptop headphones** (or whatever audio output the user actually wears).
3. In the VoiceMeeter Input column on the right (the virtual input row), confirm that both the **A1** and **A2** buttons are lit. This is what sends the same TTS audio to both destinations simultaneously.
4. Minimize VoiceMeeter — it runs in the background.

### Per-meeting workflow

1. Open the TTS app at <https://kevinday.github.io/tts-phone-bridge/>.
2. In the app's status bar, click the underlined **Output** name and pick **VoiceMeeter Input**.
3. In Teams: **Settings → Devices → Microphone → CABLE Output (VB-Audio)**.
4. Same pattern in Meet/Zoom: set the microphone to **CABLE Output (VB-Audio)**.
5. Type into the TTS app. The audio plays through the user's headphones AND goes out to the meeting at the same time.

## Setup B: Phone calls with self-monitor

This requires adding a small hardware mixer between the existing components to combine two audio streams at the earbuds.

### Current chain (no self-monitor)

```
Laptop 3.5mm out → Cubilux → SR-EA2U MIC IN → USB-C → Pixel phone
                                                         │
                                            SR-EA2U HEADPHONE OUT → earbuds
```

### Updated chain (with self-monitor)

```
Laptop 3.5mm out ─── Y-splitter ─┬─→ Cubilux → SR-EA2U MIC IN → USB-C → Pixel
                                 │                                       │
                                 │                        SR-EA2U HEADPHONE OUT
                                 │                                       │
                                 │                                       ▼
                                 └────────────────────────────→ Mixer Input A
                                                          Mixer Input B ←─┘
                                                                │
                                                                ▼
                                                       (combined out) → user's earbuds
```

The Y-splitter duplicates the laptop's TTS output: one copy continues into the existing Cubilux→SR-EA2U chain (so the caller hears it via the phone), the other copy goes into a small mixer. The SR-EA2U's headphone-out (carrying the caller's voice from the Pixel) also goes into the mixer. The mixer's output drives the user's earbuds.

### Hardware to order

| Part | Purpose | Cost |
|---|---|---|
| 3.5mm TRS Y-splitter (1M → 2F) | Splits the laptop's TTS so half goes to Cubilux as before, half goes to the mixer | ~$5 |
| 2-channel 3.5mm mixer with headphone out | Combines TTS + caller audio into one earbud feed | $15–35 |

### Recommended mixers, in preference order

1. **MX3 Mini Line Mixer** — ~$25. Two stereo 3.5mm inputs, headphone output, individual level knobs per input. Passive mode (no power) or active mode (USB-C, 5V). Top pick because the independent level knobs let the user set "louder caller, quieter self-monitor" — important for the rig to actually feel usable in practice.

2. **Saramonic AX1** — ~$35. Made by the same company as the SR-EA2U, similar build quality, passive battery-free design. Individual input attenuators. Cleanly engineered for mixing two analog sources before output. No built-in headphone amp; relies on whatever drives the output.

3. **TENEALAY X21** — ~$15. Pure passive 2-in 1-out. Cheapest option but no level controls (just sums both inputs at fixed gain). Worth trying first as a low-risk "does this approach even work" experiment before committing to a pricier mixer.

### Wiring it up

1. Unplug earbuds from the SR-EA2U.
2. Insert the Y-splitter into the laptop's 3.5mm output.
3. Connect one leg of the Y-splitter to the Cubilux (which then connects to SR-EA2U MIC IN as before).
4. Connect the other leg of the Y-splitter to **Mixer Input A**.
5. Connect a short 3.5mm cable from the SR-EA2U's HEADPHONE OUT to **Mixer Input B**.
6. Plug the user's earbuds into the mixer's headphone-out jack.
7. (If using the MX3 in active mode, plug its USB-C power cable into the laptop or a USB wall adapter.)

Test by playing TTS audio. The user should hear his own voice through his earbuds. Then make a test call to confirm both streams come through together at a balanced level.

## Caveats and tuning notes

- **Passive vs. active mixers affect earbud volume.** Passive mixers (AX1, X21) just sum the input signals; output volume drops a bit, and low-impedance earbuds may be quieter than expected. Active mixers (MX3 in powered mode) have a built-in headphone amp and drive earbuds at proper volume.
- **Level mismatch between sources.** The laptop's 3.5mm output is line-level (~1V); the SR-EA2U's headphone-out is also line-level-ish but tuned for headphones. They may not be perfectly volume-matched out of the box. Expect to tweak laptop volume vs. SR-EA2U headphone volume (or use the mixer's level knobs) to balance the two streams.
- **Self-monitor delay is real.** The user hears his own TTS roughly when the caller hears it — no extra latency from the mixer rig itself. But there is still the 75–500ms ElevenLabs synthesis latency between pressing Enter and hearing audio start, same as the caller experiences. The user will be a few hundred milliseconds behind his own keyboard.
- **Switching between phone and Teams modes.** The Y-splitter and mixer can stay in place permanently; they don't interfere with anything when not in use. For Teams meetings, just leave the SR-EA2U disconnected from the phone and route the TTS app's output to VoiceMeeter Input instead.

## Free fallback option (no new hardware)

If buying a mixer isn't appealing, the simplest no-cost alternative is to leave the user's laptop speakers on at moderate volume during phone calls. The user hears his own TTS faintly through the room, while keeping the SR-EA2U earbuds in for the caller's voice. Not as clean as a proper mix, but it uses gear already in the room and costs nothing.

This works because the phone is receiving the TTS through the wired chain (laptop → Cubilux → SR-EA2U → USB-C → phone), not through its own built-in microphone. The phone's mic isn't active in this configuration, so it won't pick up the laptop-speaker bleed and create an echo for the caller.

## Source links

- VB-Cable: <https://vb-audio.com/Cable/>
- VoiceMeeter: <https://vb-audio.com/Voicemeeter/>
- Saramonic SR-EA2U: <https://saramonicusa.com/sr-ea2u-usb-c-audio-interface-with-3-5mm-trs-or-trrs-mic-input-3-5mm-headphone-out-mute-for-android-devices-computers-ios-much-more/>
- Saramonic AX1 mixer: <https://saramonicusa.com/ax1-miniature-2-channel-3-5mm-microphone-audio-mixer-with-trs-trrs-output-cables-for-cameras-smartphones-computers-more/>
- TENEALAY X21 passive mixer: <https://www.amazon.com/TENEALAY-powered-control-passive-X21/dp/B09WDMYYBP>
