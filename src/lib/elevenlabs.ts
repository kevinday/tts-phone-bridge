/**
 * Thin client over the ElevenLabs WebSocket `stream-input` endpoint.
 *
 * Why direct WebSocket (not the official @elevenlabs/elevenlabs-js SDK):
 *   - SDK is Node-first; browser usage has historically tripped over things
 *     like Buffer polyfills and header-based auth that browsers can't set on
 *     WebSockets.
 *   - The stream-input protocol is small — ~30 lines of client code — so the
 *     tradeoff of fewer dependencies + predictable bundle size wins.
 *
 * Endpoint:
 *   wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
 *     ?model_id=eleven_flash_v2_5
 *     &output_format=pcm_16000
 *     &xi_api_key=<KEY>
 *
 * Protocol:
 *   1. After open, send an initialization message with voice_settings.
 *   2. Send zero or more `{ text: "hello " }` messages.
 *   3. Send `{ text: "" }` to flush and close.
 *   4. Server emits `{ audio: <base64>, isFinal: boolean }` messages.
 */

export interface Voice {
  voice_id: string;
  name: string;
  category?: string; // "cloned" | "premade" | ...
}

/** Fetch all voices available to this API key. Used in the setup wizard. */
export async function listVoices(apiKey: string): Promise<Voice[]> {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs /v1/voices failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { voices: Voice[] };
  return json.voices ?? [];
}

export interface StreamSpeakOptions {
  apiKey: string;
  voiceId: string;
  /** Fires for each decoded audio chunk. Caller converts base64→PCM & plays. */
  onAudioChunk: (base64Audio: string) => void;
  /** Fires when server says the utterance is complete. */
  onDone: () => void;
  /** Fires on protocol / network / auth errors. */
  onError: (err: Error) => void;
}

export interface StreamHandle {
  /** Push more text into the stream (will be spoken as it arrives). */
  send(text: string): void;
  /** Flush the remaining text and close the socket cleanly. */
  flushAndClose(): void;
  /** Abort immediately without waiting for server to finish. */
  abort(): void;
}

const MODEL_ID = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "pcm_16000";

export function openSpeakStream(opts: StreamSpeakOptions): StreamHandle {
  const { apiKey, voiceId, onAudioChunk, onDone, onError } = opts;

  // Auth goes in the first message body (see open handler); no xi_api_key
  // in the URL to keep the key out of network / access logs.
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input` +
    `?model_id=${MODEL_ID}` +
    `&output_format=${OUTPUT_FORMAT}`;

  const ws = new WebSocket(url);
  let aborted = false;
  let initSent = false;

  // Buffer any text / flush that arrived before the socket opened.
  const pendingText: string[] = [];
  let pendingFlush = false;

  ws.addEventListener("open", () => {
    // Per ElevenLabs protocol the first frame sets voice / generation config.
    // We keep voice_settings close to defaults; `use_speaker_boost` off since
    // we're going into a phone line where boost adds unwanted harshness.
    //
    // Auth: xi_api_key goes in the first message body. Browser WebSocket API
    // can't set custom headers, and the server has been rejecting query-string
    // keys (`?xi_api_key=...`) with authentication_required since early 2026.
    const init = {
      text: " ",
      xi_api_key: apiKey,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        use_speaker_boost: false,
      },
      generation_config: {
        // Chunk schedule: aggressive first chunk for low TTFB, then normal.
        chunk_length_schedule: [50, 120, 160, 290],
      },
    };
    ws.send(JSON.stringify(init));
    initSent = true;
    // Drain anything queued before open.
    for (const t of pendingText) ws.send(JSON.stringify({ text: t }));
    pendingText.length = 0;
    // If the caller already asked to flush, send the terminator now so the
    // server doesn't sit waiting for more input and trigger its 20s timeout.
    if (pendingFlush) {
      ws.send(JSON.stringify({ text: "" }));
      pendingFlush = false;
    }
  });

  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as {
        audio?: string;
        isFinal?: boolean;
        error?: string;
        message?: string;
      };
      if (msg.error) {
        onError(new Error(`ElevenLabs: ${msg.error} ${msg.message ?? ""}`));
        return;
      }
      if (msg.audio) onAudioChunk(msg.audio);
      if (msg.isFinal) onDone();
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  });

  ws.addEventListener("error", () => {
    if (!aborted) onError(new Error("WebSocket error talking to ElevenLabs"));
  });

  ws.addEventListener("close", (ev) => {
    // Normal close (1000) after `isFinal` is fine and already handled by onDone.
    // Abnormal closes should surface as errors.
    if (!aborted && ev.code !== 1000 && ev.code !== 1005) {
      onError(new Error(`WebSocket closed (${ev.code}) ${ev.reason}`));
    }
  });

  function safeSendRaw(payload: object) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    } else if (ws.readyState === WebSocket.CONNECTING) {
      // Queue until open handler runs.
      if (initSent) {
        // We already initialized; just queue text as text.
        pendingText.push((payload as { text?: string }).text ?? "");
      } else {
        pendingText.push((payload as { text?: string }).text ?? "");
      }
    }
  }

  return {
    send(text: string) {
      if (!text) return;
      // Ensure every chunk ends in whitespace — the server uses trailing
      // whitespace as a hint that more text may follow.
      const padded = text.endsWith(" ") ? text : text + " ";
      safeSendRaw({ text: padded });
    },
    flushAndClose() {
      // Empty-string text tells the server "I'm done, flush and finalize."
      // If the socket is still CONNECTING (common — callers typically send
      // text then flush synchronously after openSpeakStream), queue the flush
      // and let the open handler fire it after draining pending text.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text: "" }));
      } else if (ws.readyState === WebSocket.CONNECTING) {
        pendingFlush = true;
      }
      // The server will emit isFinal then close. We don't close() here.
    },
    abort() {
      aborted = true;
      try {
        ws.close();
      } catch {
        /* no-op */
      }
    },
  };
}
