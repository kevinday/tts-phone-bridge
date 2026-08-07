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

/**
 * Error with enough structure for the UI to react helpfully.
 *
 * Motivated by the Aug 2026 outage: the app surfaced only "401" / a fast-
 * scrolling WebSocket close reason, which made a pure credentials problem
 * look like a broken app. We now parse ElevenLabs' structured error bodies
 * (REST) and close reasons (WebSocket), translate the common cases into
 * plain language, and keep the raw server text in `serverDetail`.
 */
export class ElevenLabsError extends Error {
  /** HTTP status for REST failures, WebSocket close code for stream failures. */
  readonly code?: number;
  /** Machine-readable `detail.status` from the ElevenLabs body, if present. */
  readonly apiStatus?: string;
  /** True when the problem is the API key itself (wrong, revoked, ID, scopes). */
  readonly isAuthError: boolean;
  /** Raw server-provided text, for the "Server said: …" line in the UI. */
  readonly serverDetail?: string;

  constructor(
    message: string,
    opts: {
      code?: number;
      apiStatus?: string;
      isAuthError?: boolean;
      serverDetail?: string;
    } = {},
  ) {
    super(message);
    this.name = "ElevenLabsError";
    this.code = opts.code;
    this.apiStatus = opts.apiStatus;
    this.isAuthError = opts.isAuthError ?? false;
    this.serverDetail = opts.serverDetail;
  }
}

/**
 * Plain-language translations for the ElevenLabs error statuses we care
 * about. Anything unlisted falls back to the server's own message.
 */
const STATUS_EXPLANATIONS: Record<string, string> = {
  api_key_id_used_as_api_key:
    "The value in use is a Key ID, not an API key. A real API key starts " +
    "with sk_ and is shown only once — right after the key is created on " +
    "the ElevenLabs API-keys page. Create a new key and copy the sk_ value.",
  invalid_api_key:
    "ElevenLabs did not accept the API key. It may be mistyped, disabled, " +
    "or revoked. Create a fresh key and paste the sk_ value it shows.",
  missing_permissions:
    'The API key was accepted but is missing a permission. The key needs ' +
    '"Text to Speech" and "Voices: Read" enabled.',
  quota_exceeded:
    "The ElevenLabs account has run out of credits for this billing period.",
};

/** Statuses that mean "the key (not the request) is the problem". */
const AUTH_STATUSES = new Set([
  "api_key_id_used_as_api_key",
  "invalid_api_key",
  "missing_permissions",
  "needs_authorization",
  "authentication_required",
]);

/**
 * ElevenLabs error bodies come in a few shapes:
 *   { detail: { status: "invalid_api_key", message: "…" } }
 *   { detail: "plain text" }
 *   { detail: [{ msg: "…" }, …] }        (request-validation errors)
 */
function parseErrorBody(body: unknown): { status?: string; message?: string } {
  if (typeof body !== "object" || body === null) return {};
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return { message: detail };
  if (Array.isArray(detail)) {
    const first = detail[0] as { msg?: unknown } | undefined;
    return { message: typeof first?.msg === "string" ? first.msg : undefined };
  }
  if (typeof detail === "object" && detail !== null) {
    const d = detail as { status?: unknown; message?: unknown };
    return {
      status: typeof d.status === "string" ? d.status : undefined,
      message: typeof d.message === "string" ? d.message : undefined,
    };
  }
  return {};
}

/**
 * Fetch all voices available to this API key. Used in the setup wizard, the
 * main-screen voice picker, and as a cheap credential pre-flight on startup.
 */
export async function listVoices(apiKey: string): Promise<Voice[]> {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    let parsed: { status?: string; message?: string } = {};
    let raw = "";
    try {
      raw = await res.text();
      parsed = parseErrorBody(JSON.parse(raw));
    } catch {
      /* body missing or not JSON — fall through with what we have */
    }
    const translated =
      parsed.status !== undefined
        ? STATUS_EXPLANATIONS[parsed.status]
        : undefined;
    throw new ElevenLabsError(
      translated ??
        parsed.message ??
        `ElevenLabs /v1/voices failed: ${res.status} ${res.statusText}`,
      {
        code: res.status,
        apiStatus: parsed.status,
        isAuthError:
          res.status === 401 ||
          res.status === 403 ||
          (parsed.status !== undefined && AUTH_STATUSES.has(parsed.status)),
        serverDetail: parsed.message ?? (raw || undefined),
      },
    );
  }
  const json = (await res.json()) as { voices: Voice[] };
  return json.voices ?? [];
}

/**
 * Values that aren't sk_-prefixed are almost certainly not current API keys
 * (e.g. a Key ID copied from the dashboard, or a legacy-era credential).
 * Used for a warning, not a hard block — the server stays the final judge.
 */
export function looksLikeApiKey(value: string): boolean {
  return value.trim().startsWith("sk_");
}

/**
 * Turn a WebSocket failure (close reason and/or in-band error frame) into a
 * structured, readable error. Close code 1008 is ElevenLabs' policy-violation
 * code and covers both auth and quota problems, so we sniff the reason text.
 * Exported for testability.
 */
export function classifyStreamFailure(
  reason: string,
  code?: number,
): ElevenLabsError {
  const text = (reason || "").trim();
  const quota = /quota|credit/i.test(text);
  const keyId = /key\s*id/i.test(text);
  const auth =
    !quota &&
    (keyId || /api[\s_-]?key|auth|unauthorized|permission/i.test(text));
  if (quota) {
    return new ElevenLabsError(STATUS_EXPLANATIONS.quota_exceeded, {
      code,
      apiStatus: "quota_exceeded",
      serverDetail: text,
    });
  }
  if (auth) {
    return new ElevenLabsError(
      keyId
        ? STATUS_EXPLANATIONS.api_key_id_used_as_api_key
        : "ElevenLabs rejected the saved API key, so nothing was spoken. " +
          "The key may be revoked, disabled, or missing permissions.",
      { code, isAuthError: true, serverDetail: text },
    );
  }
  return new ElevenLabsError(
    code !== undefined
      ? `WebSocket closed (${code}) ${text}`.trim()
      : `ElevenLabs: ${text}`,
    { code, serverDetail: text || undefined },
  );
}

export interface StreamSpeakOptions {
  apiKey: string;
  voiceId: string;
  /**
   * Optional speech-rate multiplier. ElevenLabs accepts 0.7–1.2:
   *   0.7 = slowest, 1.0 = default unchanged, 1.2 = fastest.
   * Out-of-range values may be silently clamped or rejected by the server,
   * so callers should validate before passing. Omit to use the default.
   */
  speed?: number;
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
  const { apiKey, voiceId, speed, onAudioChunk, onDone, onError } = opts;

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
    // Only include `speed` in voice_settings if the caller provided one —
    // omitting it lets the server fall back to the default (1.0). Sending
    // explicit `speed: 1` is harmless but unnecessary noise.
    const voiceSettings: {
      stability: number;
      similarity_boost: number;
      use_speaker_boost: boolean;
      speed?: number;
    } = {
      stability: 0.5,
      similarity_boost: 0.8,
      use_speaker_boost: false,
    };
    if (typeof speed === "number" && Number.isFinite(speed)) {
      voiceSettings.speed = speed;
    }

    const init = {
      text: " ",
      xi_api_key: apiKey,
      voice_settings: voiceSettings,
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
        onError(
          classifyStreamFailure(`${msg.error} ${msg.message ?? ""}`.trim()),
        );
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
    // Abnormal closes should surface as errors — classified, so auth problems
    // (e.g. close 1008 "API key ID used as API key") arrive as readable
    // ElevenLabsError objects with isAuthError set.
    if (!aborted && ev.code !== 1000 && ev.code !== 1005) {
      onError(classifyStreamFailure(ev.reason, ev.code));
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
