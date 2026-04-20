/**
 * Streaming chunk scheduler for PCM audio from ElevenLabs WebSocket.
 *
 * Why PCM (not MP3)?
 *   - Every chunk is individually playable — no decode ambiguity at chunk
 *     boundaries, no MP3 frame alignment worries.
 *   - Zero decode latency on each chunk.
 *   - Trivially cheap for phone-quality audio (16kHz * 16-bit = 32 KB/s).
 *
 * Sample-rate strategy:
 *   We DON'T force the AudioContext to 16kHz. Forcing it has caused silent
 *   failures on Mac Chrome when setSinkId points at a 48kHz device. Instead,
 *   the context uses the system rate, and each AudioBuffer is created at
 *   16kHz — BufferSourceNode auto-resamples on playback, which is the
 *   battle-tested path.
 */

import { applySinkToAudioContext } from "./audioOutput";

export type PlayerState = "idle" | "speaking";

export interface SinkStatus {
  applied: boolean;
  deviceId: string;
}

export interface AudioPlayer {
  /** Apply (or re-apply) the chosen output device. */
  setSink(deviceId: string): Promise<boolean>;
  /** Current sink state — whether setSinkId actually applied. */
  getSinkStatus(): SinkStatus;
  /** Enqueue a chunk of PCM16LE @ 16kHz audio. */
  enqueuePCM16(int16: Int16Array): void;
  /** Called by the WebSocket client when streaming for an utterance is done. */
  markStreamEnd(): void;
  /** Stop playback immediately and drop any queued audio. */
  cancel(): void;
  /** Set playback gain (0.0 .. ~4.0 — values above 1 amplify). */
  setVolume(v: number): void;
  /** Current gain value. */
  getVolume(): number;
  /** Subscribe to state changes. */
  onStateChange(cb: (state: PlayerState) => void): () => void;
  /** Subscribe to "first chunk has actually started audibly playing" — used for latency measurement. */
  onFirstAudio(cb: () => void): () => void;
  /** Current state. */
  getState(): PlayerState;
  /** Direct access to the context state for diagnostics. */
  getContextState(): AudioContextState;
  /** Ensure the context is running — call on user gesture. */
  resume(): Promise<void>;
}

// Incoming audio sample rate from ElevenLabs (pcm_16000). AudioBuffer is
// created at this rate and auto-resampled by the BufferSourceNode.
const SOURCE_SAMPLE_RATE = 16000;

export function createAudioPlayer(): AudioPlayer {
  // Long-lived context. Browsers require a user gesture before it transitions
  // from "suspended" to "running" — that happens on the first wizard click.
  const ctx = new AudioContext();

  // A single gain node lets us add volume control without rewiring the graph.
  const gain = ctx.createGain();
  gain.gain.value = 1;
  gain.connect(ctx.destination);

  let sinkStatus: SinkStatus = { applied: false, deviceId: "" };

  let nextStartTime = 0;
  const liveSources = new Set<AudioBufferSourceNode>();
  let state: PlayerState = "idle";
  let streamEnded = false;
  let firstAudioFired = false;

  const stateSubs = new Set<(s: PlayerState) => void>();
  const firstAudioSubs = new Set<() => void>();

  function setState(next: PlayerState) {
    if (state === next) return;
    state = next;
    stateSubs.forEach((cb) => cb(state));
  }

  return {
    async setSink(deviceId: string) {
      const ok = await applySinkToAudioContext(ctx, deviceId);
      sinkStatus = { applied: ok, deviceId };
      return ok;
    },

    getSinkStatus() {
      return sinkStatus;
    },

    async resume() {
      if (ctx.state !== "running") await ctx.resume();
    },

    setVolume(v: number) {
      gain.gain.setValueAtTime(Math.max(0, v), ctx.currentTime);
    },

    getVolume() {
      return gain.gain.value;
    },

    getContextState() {
      return ctx.state;
    },

    enqueuePCM16(int16: Int16Array) {
      if (ctx.state !== "running") {
        void ctx.resume();
      }

      // Convert PCM16 → Float32 in [-1, 1].
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      // Buffer at the source rate (16kHz). BufferSourceNode will resample
      // to ctx.sampleRate automatically during playback.
      const buffer = ctx.createBuffer(1, float32.length, SOURCE_SAMPLE_RATE);
      buffer.copyToChannel(float32, 0);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);

      // If the cursor is behind the current clock, it means playback drained
      // while we were awaiting the next chunk. Jump the cursor forward to
      // "now + a small cushion" to avoid scheduling in the past (which causes
      // the browser to play it immediately but glitchy).
      const now = ctx.currentTime;
      if (nextStartTime < now) {
        // 20ms cushion — enough to absorb jitter without an audible gap.
        nextStartTime = now + 0.02;
      }

      source.start(nextStartTime);
      nextStartTime += buffer.duration;

      liveSources.add(source);
      setState("speaking");
      streamEnded = false;

      // Fire first-audio callback at the moment this chunk actually starts
      // playing. We use a scheduled `onended` of a zero-length helper or
      // simply setTimeout aligned to the AudioContext clock.
      if (!firstAudioFired) {
        const delay = Math.max(0, (nextStartTime - buffer.duration - now) * 1000);
        firstAudioFired = true;
        window.setTimeout(() => firstAudioSubs.forEach((cb) => cb()), delay);
      }

      source.onended = () => {
        liveSources.delete(source);
        // If nothing live is left AND the server said it's done sending,
        // we're back to idle.
        if (liveSources.size === 0 && streamEnded) {
          nextStartTime = 0;
          firstAudioFired = false;
          setState("idle");
        }
      };
    },

    markStreamEnd() {
      streamEnded = true;
      // If everything already played, go idle right away.
      if (liveSources.size === 0) {
        nextStartTime = 0;
        firstAudioFired = false;
        setState("idle");
      }
    },

    cancel() {
      liveSources.forEach((s) => {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      });
      liveSources.clear();
      nextStartTime = 0;
      streamEnded = true;
      firstAudioFired = false;
      setState("idle");
    },

    onStateChange(cb) {
      stateSubs.add(cb);
      return () => stateSubs.delete(cb) as unknown as void;
    },

    onFirstAudio(cb) {
      firstAudioSubs.add(cb);
      return () => firstAudioSubs.delete(cb) as unknown as void;
    },

    getState() {
      return state;
    },
  };
}

/**
 * Decode a base64 string into an Int16Array of PCM samples (little-endian).
 * Used by the WebSocket client to unwrap audio chunks from ElevenLabs.
 */
export function base64ToPCM16(b64: string): Int16Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  // PCM16 is 2 bytes per sample; use DataView so endianness is explicit.
  const view = new DataView(bytes.buffer);
  const samples = new Int16Array(len / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true); // little-endian
  }
  return samples;
}
