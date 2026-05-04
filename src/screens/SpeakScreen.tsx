import { useCallback, useEffect, useRef, useState } from "react";
import { base64ToPCM16, type AudioPlayer, type PlayerState } from "../lib/audioPlayer";
import { openSpeakStream, type StreamHandle } from "../lib/elevenlabs";
import {
  listOutputDevices,
  looksLikeLaptopSpeakers,
  pickOutputDevice,
  primeDevicePermissions,
  type AudioDevice,
} from "../lib/audioOutput";
import {
  IDLE_FLUSH_MS_MAX,
  IDLE_FLUSH_MS_MIN,
  saveAutoSendPunctuation,
  saveIdleFlushMs,
  saveOutputDevice,
  saveQuickPhrases,
  saveRealtimeMode,
  type Settings,
} from "../lib/settings";
import { QuickPhrasesEditor } from "../components/QuickPhrasesEditor";

interface Props {
  player: AudioPlayer;
  settings: Settings;
  onOpenSettings: () => void;
}

// Sentence-ending punctuation followed by a space — the "commit signal" for
// auto-send. Requiring the trailing space keeps things like "Mr. Smith" from
// firing prematurely.
const AUTO_SEND_REGEX = /[.!?]\s$/;

// Detect Chromium-style native audio output picker availability once.
function hasNativeOutputPicker(): boolean {
  return (
    typeof (
      navigator.mediaDevices as MediaDevices & {
        selectAudioOutput?: () => unknown;
      }
    ).selectAudioOutput === "function"
  );
}

export function SpeakScreen({ player, settings, onOpenSettings }: Props) {
  const [text, setText] = useState("");
  const [state, setState] = useState<PlayerState>(player.getState());
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [queued, setQueued] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastUtterance, setLastUtterance] = useState<string>("");

  // Local-only mirrors so the UI updates immediately when the user flips them;
  // the persisted settings object is the source of truth on reload.
  const [autoSend, setAutoSend] = useState(settings.autoSendPunctuation);
  const [quickPhrases, setQuickPhrases] = useState(settings.quickPhrases);
  const [showEditor, setShowEditor] = useState(false);

  // Realtime mode state — experimental "stream as you type" path. The legacy
  // press-Enter path is unaffected when this is off.
  const [realtimeMode, setRealtimeMode] = useState(settings.realtimeMode);
  const [idleFlushMs, setIdleFlushMs] = useState(settings.idleFlushMs);

  // Output device — duplicated locally so the user can change it from the
  // typing screen (e.g., switching between phone cable and a virtual audio
  // cable for Teams/Meet) without bouncing through the wizard.
  const [outputDeviceId, setOutputDeviceId] = useState(settings.outputDeviceId);
  const [outputDeviceLabel, setOutputDeviceLabel] = useState(
    settings.outputDeviceLabel,
  );
  const [outputPickerError, setOutputPickerError] = useState<string | null>(null);
  // Fallback (Firefox/Safari) state — populated lazily when the user clicks
  // "Change..." on a non-Chromium browser.
  const [showFallbackDevices, setShowFallbackDevices] = useState(false);
  const [fallbackDevices, setFallbackDevices] = useState<AudioDevice[]>([]);
  const nativePicker = hasNativeOutputPicker();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sendStartRef = useRef<number | null>(null);

  // ----- Legacy (press-Enter / auto-send-on-punctuation) plumbing -----
  // These refs and the `speak` / `speakOrQueue` callbacks below are the
  // *exact* same code path that has been working in production. The realtime
  // path is added alongside, never replaces.
  const activeStreamRef = useRef<StreamHandle | null>(null);
  // Queue for utterances received while a previous one is still streaming.
  const queueRef = useRef<string[]>([]);

  // ----- Realtime stream plumbing -----
  // A single long-lived stream that text is dripped into as the user types.
  // Closed (flushAndClose) on terminal punctuation, Enter, idle, or unmount.
  const realtimeStreamRef = useRef<StreamHandle | null>(null);
  // The text already committed to the open realtime stream — used to compute
  // diffs against the textarea value. Reset to "" whenever the stream resets.
  const realtimeBaseRef = useRef<string>("");
  // Idle-flush timer handle. Cleared on every keystroke, fires after the
  // user-configured pause to commit the in-progress phrase.
  const idleTimerRef = useRef<number | null>(null);
  // Most-recent realtime mode value, accessible from cleanup callbacks.
  const realtimeModeRef = useRef(realtimeMode);
  realtimeModeRef.current = realtimeMode;

  // ---------- Effects ----------
  useEffect(() => {
    const unsub = player.onStateChange(setState);
    return () => unsub();
  }, [player]);

  useEffect(() => {
    const unsub = player.onFirstAudio(() => {
      if (sendStartRef.current !== null) {
        setLastLatencyMs(Math.round(performance.now() - sendStartRef.current));
        sendStartRef.current = null;
      }
    });
    return () => unsub();
  }, [player]);

  // Focus the textarea on mount.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // On unmount, cleanly tear down any open realtime stream and timers.
  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      realtimeStreamRef.current?.abort();
      realtimeStreamRef.current = null;
    };
  }, []);

  // ---------- Legacy speak path (unchanged behavior) ----------
  const speak = useCallback(
    (utterance: string) => {
      const trimmed = utterance.trim();
      if (!trimmed) return;
      sendStartRef.current = performance.now();
      setError(null);
      setLastUtterance(trimmed);
      const stream = openSpeakStream({
        apiKey: settings.apiKey,
        voiceId: settings.voiceId,
        onAudioChunk: (b64) => player.enqueuePCM16(base64ToPCM16(b64)),
        onDone: () => {
          player.markStreamEnd();
          activeStreamRef.current = null;
          // If more utterances queued up, fire the next one.
          const next = queueRef.current.shift();
          setQueued(queueRef.current.length);
          if (next) speak(next);
        },
        onError: (err) => {
          setError(err.message);
          player.cancel();
          activeStreamRef.current = null;
          queueRef.current = [];
          setQueued(0);
        },
      });
      activeStreamRef.current = stream;
      stream.send(trimmed);
      stream.flushAndClose();
    },
    [settings.apiKey, settings.voiceId, player],
  );

  const speakOrQueue = useCallback(
    async (utterance: string) => {
      const trimmed = utterance.trim();
      if (!trimmed) return;
      await player.resume();
      if (player.getState() === "speaking") {
        queueRef.current.push(trimmed);
        setQueued(queueRef.current.length);
      } else {
        speak(trimmed);
      }
    },
    [player, speak],
  );

  // ---------- Realtime stream helpers ----------
  // Opens a fresh realtime stream and stores it in realtimeStreamRef. Caller
  // is responsible for sending text after this returns.
  const openRealtimeStream = useCallback((): StreamHandle => {
    sendStartRef.current = performance.now();
    setError(null);
    realtimeBaseRef.current = "";
    const stream = openSpeakStream({
      apiKey: settings.apiKey,
      voiceId: settings.voiceId,
      onAudioChunk: (b64) => player.enqueuePCM16(base64ToPCM16(b64)),
      onDone: () => {
        player.markStreamEnd();
        // Only clear the ref if THIS is still the current stream — the user
        // may have already aborted+reopened on a backspace.
        if (realtimeStreamRef.current === stream) {
          realtimeStreamRef.current = null;
          realtimeBaseRef.current = "";
        }
      },
      onError: (err) => {
        setError(err.message);
        if (realtimeStreamRef.current === stream) {
          realtimeStreamRef.current = null;
          realtimeBaseRef.current = "";
        }
      },
    });
    realtimeStreamRef.current = stream;
    return stream;
  }, [settings.apiKey, settings.voiceId, player]);

  // Cancel any pending idle flush — called whenever a fresh keystroke arrives
  // or when we explicitly commit/abort.
  function clearIdleTimer() {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }

  // Schedule auto-flush of the in-progress realtime phrase.
  const scheduleIdleFlush = useCallback(() => {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      const stream = realtimeStreamRef.current;
      if (!stream) return;
      // Capture what's been spoken, mirror to lastUtterance for the Repeat button.
      const committed = realtimeBaseRef.current.trim();
      if (committed) setLastUtterance(committed);
      stream.flushAndClose();
      // The stream's onDone clears realtimeStreamRef; we also clear the
      // textarea so the next phrase starts fresh.
      setText("");
      realtimeBaseRef.current = "";
    }, idleFlushMs);
  }, [idleFlushMs]);

  // Abort whatever realtime stream may be open. Used on backspace, on
  // toggling realtime off, on Stop, etc. Audio already queued in the player
  // continues — we deliberately don't cancel the player (jarring cut).
  const abortRealtimeStream = useCallback(() => {
    clearIdleTimer();
    realtimeStreamRef.current?.abort();
    realtimeStreamRef.current = null;
    realtimeBaseRef.current = "";
  }, []);

  // Commit the current realtime phrase immediately (Enter key, terminal
  // punctuation, quick phrase click, etc.). Idempotent if no stream is open.
  const flushRealtimeNow = useCallback(() => {
    clearIdleTimer();
    const stream = realtimeStreamRef.current;
    if (stream) {
      const committed = realtimeBaseRef.current.trim();
      if (committed) setLastUtterance(committed);
      stream.flushAndClose();
    }
    realtimeBaseRef.current = "";
    setText("");
  }, []);

  // ---------- Realtime text-change handler ----------
  // Called from handleTextChange when realtimeMode is on. Implements the
  // diff-and-dispatch policy described in the design doc:
  //   - append → send the new chars through the stream
  //   - backspace / mid-edit → abort and restart with the new text
  //   - terminal punctuation → flush + close
  function handleRealtimeTextChange(prev: string, next: string) {
    // Trivial / no-op cases.
    if (next === prev) return;

    // Empty buffer — nothing to do, just reset state.
    if (next.length === 0) {
      abortRealtimeStream();
      return;
    }

    const isAppend = next.length > prev.length && next.startsWith(prev);

    if (isAppend) {
      const appended = next.slice(prev.length);
      if (!realtimeStreamRef.current) {
        // First keystroke of a fresh phrase — open a stream, then send.
        // The send is non-blocking; the StreamHandle queues it until open.
        openRealtimeStream().send(next);
        realtimeBaseRef.current = next;
      } else {
        realtimeStreamRef.current.send(appended);
        realtimeBaseRef.current += appended;
      }

      // Terminal punctuation acts the same way auto-send does in legacy mode:
      // it commits the phrase immediately. We do this regardless of the
      // legacy autoSend toggle — in realtime mode, terminal punctuation is
      // ALWAYS a commit boundary (the legacy toggle is dimmed in the UI).
      if (AUTO_SEND_REGEX.test(next)) {
        flushRealtimeNow();
        return;
      }

      scheduleIdleFlush();
      return;
    }

    // Anything else — backspace, mid-text edit, paste-replace — is treated
    // as "abandon and restart." Already-generated audio plays out; new audio
    // generation begins fresh from the current text.
    abortRealtimeStream();
    if (next.trim().length > 0) {
      openRealtimeStream().send(next);
      realtimeBaseRef.current = next;
      scheduleIdleFlush();
    }
  }

  // ---------- Top-level event handlers ----------
  function handleSend() {
    const utterance = text.trim();
    if (!utterance) return;
    if (realtimeModeRef.current) {
      flushRealtimeNow();
      return;
    }
    setText("");
    textareaRef.current?.focus();
    void speakOrQueue(utterance);
  }

  function handleCancel() {
    // Legacy stream cleanup
    activeStreamRef.current?.abort();
    activeStreamRef.current = null;
    queueRef.current = [];
    setQueued(0);
    // Realtime stream cleanup
    abortRealtimeStream();
    setText("");
    player.cancel();
  }

  function handleRepeat() {
    if (!lastUtterance) return;
    // Repeat is always treated as a discrete utterance — flush any in-flight
    // realtime phrase first, then play through the legacy path.
    if (realtimeModeRef.current) flushRealtimeNow();
    void speakOrQueue(lastUtterance);
  }

  function handleQuickPhrase(phrase: string) {
    // Quick phrases are pre-canned, complete utterances. Use the legacy path
    // for them in both modes — flushing any open realtime stream first so
    // the patient's in-progress typing is committed first.
    if (realtimeModeRef.current) flushRealtimeNow();
    void speakOrQueue(phrase);
  }

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    const prev = text;

    if (realtimeModeRef.current) {
      // Realtime path. The textarea is the source of truth — we always update
      // it before any async work so the user sees their keystrokes register.
      setText(next);
      // Resume the audio context lazily on the same user gesture (typing).
      // Browsers tolerate this; nothing else upstream awaits.
      void player.resume();
      handleRealtimeTextChange(prev, next);
      return;
    }

    // Legacy path: trigger auto-send when user has just typed a sentence end.
    if (autoSend && AUTO_SEND_REGEX.test(next) && !AUTO_SEND_REGEX.test(prev)) {
      setText("");
      void speakOrQueue(next);
      return;
    }
    setText(next);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  }

  function toggleAutoSend() {
    // No-op when realtime is on — checkbox is rendered disabled, but guard
    // here too in case a stale reference fires.
    if (realtimeMode) return;
    const next = !autoSend;
    setAutoSend(next);
    saveAutoSendPunctuation(next);
  }

  function toggleRealtime() {
    const next = !realtimeMode;
    setRealtimeMode(next);
    saveRealtimeMode(next);
    // Cleanly tear down any open realtime stream when turning OFF, so we
    // don't leave a half-spoken phrase mid-air.
    if (!next) abortRealtimeStream();
  }

  function changeIdleFlush(ms: number) {
    const clamped = Math.min(IDLE_FLUSH_MS_MAX, Math.max(IDLE_FLUSH_MS_MIN, ms));
    setIdleFlushMs(clamped);
    saveIdleFlushMs(clamped);
  }

  function onEditorSave(phrases: string[]) {
    setQuickPhrases(phrases);
    saveQuickPhrases(phrases);
    setShowEditor(false);
  }

  // ---------- Output device picker (main-screen flavor) ----------
  async function handleChangeOutput() {
    setOutputPickerError(null);
    // Picking a new output is a "session-significant" event — flush any
    // realtime phrase first so it doesn't keep streaming to the old device.
    if (realtimeModeRef.current) flushRealtimeNow();

    if (nativePicker) {
      try {
        await player.resume();
        const picked = await pickOutputDevice();
        if (!picked) return; // user dismissed
        const ok = await player.setSink(picked.deviceId);
        setOutputDeviceId(picked.deviceId);
        setOutputDeviceLabel(picked.label);
        saveOutputDevice(picked.deviceId, picked.label);
        if (!ok) {
          setOutputPickerError(
            "Browser couldn't apply the selection — audio may still play through the default output.",
          );
        }
      } catch (err) {
        setOutputPickerError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Non-Chromium fallback — show an inline dropdown of audio outputs.
    if (!showFallbackDevices) {
      await primeDevicePermissions();
      const devices = await listOutputDevices();
      setFallbackDevices(devices);
      setShowFallbackDevices(true);
    } else {
      setShowFallbackDevices(false);
    }
  }

  async function chooseFallbackOutput(deviceId: string) {
    const d = fallbackDevices.find((x) => x.deviceId === deviceId);
    if (!d) return;
    await player.resume();
    const ok = await player.setSink(d.deviceId);
    setOutputDeviceId(d.deviceId);
    setOutputDeviceLabel(d.label);
    saveOutputDevice(d.deviceId, d.label);
    setShowFallbackDevices(false);
    if (!ok) {
      setOutputPickerError(
        "Browser couldn't apply the selection — audio may still play through the default output.",
      );
    }
  }

  const wrongOutput = looksLikeLaptopSpeakers(outputDeviceLabel);

  return (
    <div className="flex-1 flex flex-col">
      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 text-xs text-slate-400">
        <div className="flex items-center gap-4 flex-wrap">
          <span>
            Voice:{" "}
            <span className="text-slate-200">{settings.voiceName || "—"}</span>
          </span>
          <span className="flex items-center gap-1">
            <span>Output:</span>
            <button
              className="text-slate-200 underline decoration-dotted hover:text-sky-300 underline-offset-2"
              onClick={handleChangeOutput}
              title="Click to change output device (e.g., switch between the phone cable and a virtual audio cable for Teams/Meet)"
            >
              {outputDeviceLabel || "—"}
            </button>
          </span>
          {lastLatencyMs !== null && (
            <span>
              {realtimeMode ? "First audio" : "TTFB"}:{" "}
              <span className="text-slate-200">{lastLatencyMs}ms</span>
            </span>
          )}
          <label
            className={[
              "flex items-center gap-1 select-none",
              realtimeMode ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
            ].join(" ")}
            title={
              realtimeMode
                ? "Always-on in real-time mode"
                : "Auto-send when you finish a sentence with .?! + space"
            }
          >
            <input
              type="checkbox"
              checked={autoSend}
              onChange={toggleAutoSend}
              disabled={realtimeMode}
              className="accent-sky-500"
            />
            <span>Auto-send on .?!</span>
          </label>
          <label
            className="flex items-center gap-1 cursor-pointer select-none"
            title="Experimental: stream audio while you're still typing, instead of waiting for Enter / punctuation. May have rough edges around backspace and mid-sentence pauses."
          >
            <input
              type="checkbox"
              checked={realtimeMode}
              onChange={toggleRealtime}
              className="accent-amber-400"
            />
            <span>
              Real-time{" "}
              <span className="text-amber-400">(experimental)</span>
            </span>
          </label>
          {realtimeMode && (
            <label
              className="flex items-center gap-1 select-none"
              title={`Time to wait after typing pauses before committing the in-progress phrase to audio. Lower = faster reactions but may split a single thought into multiple utterances. Higher = better prosody but more silence between phrases. Range: ${IDLE_FLUSH_MS_MIN}-${IDLE_FLUSH_MS_MAX}ms.`}
            >
              <span>Idle flush:</span>
              <input
                type="number"
                min={IDLE_FLUSH_MS_MIN}
                max={IDLE_FLUSH_MS_MAX}
                step={100}
                value={idleFlushMs}
                onChange={(e) => changeIdleFlush(Number(e.target.value))}
                className="w-16 bg-slate-800 text-slate-100 rounded px-1 py-0.5 text-xs"
              />
              <span>ms</span>
            </label>
          )}
        </div>
        <button
          className="text-slate-400 hover:text-slate-200"
          onClick={onOpenSettings}
        >
          Settings
        </button>
      </div>

      {/* Inline fallback output-device dropdown (Firefox / Safari path) */}
      {showFallbackDevices && (
        <div className="bg-slate-800 border-b border-slate-700 px-4 py-2 text-xs flex items-center gap-2">
          <span className="text-slate-400">Pick output:</span>
          <select
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100"
            value={outputDeviceId}
            onChange={(e) => chooseFallbackOutput(e.target.value)}
          >
            <option value="">— Select —</option>
            {fallbackDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          <button
            className="text-slate-400 hover:text-slate-200"
            onClick={() => setShowFallbackDevices(false)}
          >
            Close
          </button>
        </div>
      )}

      {wrongOutput && (
        <div className="bg-amber-500/20 border-b border-amber-500 text-amber-200 px-4 py-2 text-sm">
          ⚠️ Current output looks like laptop speakers, not the phone cable.
          Click the output name above to change it.
        </div>
      )}

      {outputPickerError && (
        <div className="bg-rose-500/20 border-b border-rose-500 text-rose-200 px-4 py-2 text-sm flex justify-between">
          <span>Output picker: {outputPickerError}</span>
          <button onClick={() => setOutputPickerError(null)}>×</button>
        </div>
      )}

      {error && (
        <div className="bg-rose-500/20 border-b border-rose-500 text-rose-200 px-4 py-2 text-sm flex justify-between">
          <span>Error: {error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Quick phrases */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-800 overflow-x-auto">
        {quickPhrases.map((phrase) => (
          <button
            key={phrase}
            className="bg-slate-800 hover:bg-slate-700 text-slate-100 px-3 py-2 rounded text-sm whitespace-nowrap"
            onClick={() => handleQuickPhrase(phrase)}
          >
            {phrase}
          </button>
        ))}
        <button
          className="text-slate-400 hover:text-slate-200 text-sm px-2 py-2 whitespace-nowrap"
          onClick={() => setShowEditor(true)}
          title="Edit quick phrases"
        >
          ✎ Edit
        </button>
      </div>

      {/* Big textarea — the whole middle of the screen. */}
      <textarea
        ref={textareaRef}
        className="flex-1 w-full bg-slate-900 text-slate-100 text-2xl sm:text-3xl p-6 resize-none outline-none leading-relaxed"
        placeholder={
          realtimeMode
            ? "Type — speech streams as you go. Punctuation or pause commits the phrase."
            : autoSend
              ? "Type — finish a sentence with .?! + space to auto-send, or press Enter."
              : "Type what you want to say, then press Enter..."
        }
        value={text}
        onChange={handleTextChange}
        onKeyDown={handleKeyDown}
      />

      {/* Bottom action bar */}
      <div className="flex items-center gap-3 p-4 border-t border-slate-800">
        <button
          className="bg-slate-700 hover:bg-slate-600 text-slate-100 px-4 py-4 rounded font-medium disabled:opacity-30"
          onClick={handleRepeat}
          disabled={!lastUtterance}
          title={lastUtterance ? `Repeat: "${lastUtterance}"` : "Nothing to repeat yet"}
        >
          ↻ Repeat
        </button>
        <button
          className="flex-1 bg-sky-500 text-slate-900 text-xl font-semibold py-4 rounded disabled:opacity-50"
          onClick={handleSend}
          disabled={!text.trim() && queued === 0}
        >
          {state === "speaking"
            ? queued > 0
              ? `Speaking — ${queued} queued`
              : "Speaking..."
            : realtimeMode
              ? "Commit  (Enter)"
              : "Speak  (Enter)"}
        </button>
        <button
          className="bg-slate-700 text-slate-100 px-6 py-4 rounded font-medium disabled:opacity-30"
          onClick={handleCancel}
          // In realtime mode, allow Stop whenever there's text in the buffer —
          // even if no audio is playing yet (the user may want to abandon a
          // phrase before it commits). The ref-based check we'd otherwise want
          // (`realtimeStreamRef.current`) doesn't trigger re-renders.
          disabled={
            state === "idle" &&
            queued === 0 &&
            !(realtimeMode && text.length > 0)
          }
          title="Esc"
        >
          Stop
        </button>
      </div>

      {showEditor && (
        <QuickPhrasesEditor
          initial={quickPhrases}
          onClose={() => setShowEditor(false)}
          onSave={onEditorSave}
        />
      )}
    </div>
  );
}
