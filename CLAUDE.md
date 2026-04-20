# ALS Patient: Text-to-Voice Phone Call Project

## Goal
An ALS patient who can no longer speak but types quickly needs to participate in normal phone calls on Android. They type on a computer → ElevenLabs (with their voice clone) synthesizes speech → the caller hears that synthesized voice through the phone call. The patient hears the other party through earbuds.

## All Hardware (fully purchased as of April 2026)

| Item | Purpose |
|------|---------|
| jstma USB-C → 3.5mm TRRS adapter | Gives the Android phone a headset jack |
| Kingtop TRRS splitter (1M → 2F) | Splits that jack into separate headphone + mic legs |
| Cubilux attenuator cable (-10/-20/-30dB switchable, ASIN B0F9DR496H) | Drops computer line-level (~1V) down to mic-level (~30mV) |
| CableCreation 0.45m 3.5mm aux cable | Spare / extension if Cubilux cable is too short |

## Signal Chain

```
Computer headphone-out
        ↓
Cubilux attenuator (start at -30dB)
        ↓
Kingtop splitter — mic-side jack (pink)
        ↑
   [TRRS male plug — sleeve OFF]
        ↓
Kingtop splitter — headphone-side jack (green)
        ↑
   White earbuds (patient hears caller here)
        ↓
jstma USB-C adapter
        ↓
Android phone
```

## Critical Setup Notes
- **Kingtop sleeve: must be OFF** — sleeve-on disables the mic channel (TRS mode), sleeve-off enables it (TRRS mode). If the sleeve is on, the caller hears nothing.
- **TRRS wiring**: Kingtop is CTIA — matches modern Android. No compatibility issue.
- **Cubilux replaces CableCreation** in the chain. Keep CableCreation as a spare or chain it before Cubilux if more length is needed.

## Known Limitations
- Patient won't hear their own TTS in the earbuds — earbuds carry only the caller's voice. They read their typed text on screen instead.
- No ambient sound reaches the caller — TTS or silence only. This is intentional.
- ElevenLabs latency ~300–500ms. Use the turbo/low-latency model to minimize gaps.
- Ground loop hum is possible once computer is connected to phone audio chain. Fix: add a 3.5mm ground loop isolator (~$10) in the chain if needed.

## Test Procedure (before first real call)
1. Plug everything together
2. Record a voice memo on the phone while playing TTS through the computer
3. Listen back — distorted = go to -30dB or lower computer volume; too quiet = back off to -20dB
4. Then do a live test call

## Status (April 2026)
- All hardware purchased and in hand
- Setup not yet tested
- ElevenLabs voice clone: in use (model preference: turbo/low-latency)
