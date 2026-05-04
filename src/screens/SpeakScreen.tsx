import { useCallback, useEffect, useRef, useState } from "react";
import { base64ToPCM16, type AudioPlayer, type PlayerState } from "../lib/audioPlayer";
import {
  listVoices,
  openSpeakStream,
  type StreamHandle,
  type Voice,
} from "../lib/elevenlabs";
import {
  listOutputDevices,
  looksLikeLaptopSpeakers,
  pickOutputDevice,
  primeDevicePermissions,
  type AudioDevice,
} from "../lib/audioOutput";
import {
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  saveAutoSendPunctuation,
  saveOutputDevice,
  saveQuickPhrases,
  saveSpeed,
  saveVoice,
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

  // Voice — duplicated locally so the user can switch voice mid-session
  // without re-running the wizard. The voice list is fetched lazily on the
  // first time the picker opens, then cached in this component.
  const [voiceId, setVoiceId] = useState(settings.voiceId);
  const [voiceName, setVoiceName] = useState(settings.voiceName);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voicePickerError, setVoicePickerError] = useState<string | null>(null);

  // Speech-rate multiplier (0.7–1.2). 1.0 leaves the ElevenLabs default
  // unchanged. Saved to localStorage on every change so it persists across
  // sessions; the next openSpeakStream call picks up the latest value.
  const [speed, setSpeed] = useState(settings.speed);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sendStartRef = useRef<number | null>(null);
  const activeStreamRef = useRef<StreamHandle | null>(null);
  // Queue for utterances received while a previous one is still streaming.
  const queueRef = useRef<string[]>([]);

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

  // ---------- Speak path ----------
  const speak = useCallback(
    (utterance: string) => {
      const trimmed = utterance.trim();
      if (!trimmed) return;
      sendStartRef.current = performance.now();
      setError(null);
      setLastUtterance(trimmed);
      const stream = openSpeakStream({
        apiKey: settings.apiKey,
        voiceId,
        // Only send `speed` when it differs from the API default — keeps the
        // wire payload identical to the legacy behavior when the slider hasn't
        // been moved.
        speed: speed === SPEED_DEFAULT ? undefined : speed,
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
    [settings.apiKey, voiceId, speed, player],
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

  // ---------- Top-level event handlers ----------
  function handleSend() {
    const utterance = text.trim();
    if (!utterance) return;
    setText("");
    textareaRef.current?.focus();
    void speakOrQueue(utterance);
  }

  function handleCancel() {
    activeStreamRef.current?.abort();
    activeStreamRef.current = null;
    queueRef.current = [];
    setQueued(0);
    player.cancel();
  }

  function handleRepeat() {
    if (lastUtterance) void speakOrQueue(lastUtterance);
  }

  function handleQuickPhrase(phrase: string) {
    void speakOrQueue(phrase);
  }

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    // Only trigger auto-send when the user is typing new characters at the
    // end — not on e.g. pasting or cursor-in-middle edits. The cheapest heuristic
    // is: the textarea ends with ".?! " now and didn't a moment ago.
    if (autoSend && AUTO_SEND_REGEX.test(next) && !AUTO_SEND_REGEX.test(text)) {
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
    const next = !autoSend;
    setAutoSend(next);
    saveAutoSendPunctuation(next);
  }

  function onEditorSave(phrases: string[]) {
    setQuickPhrases(phrases);
    saveQuickPhrases(phrases);
    setShowEditor(false);
  }

  // ---------- Output device picker (main-screen flavor) ----------
  async function handleChangeOutput() {
    setOutputPickerError(null);

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

  // ---------- Voice picker (main-screen flavor) ----------
  // Toggle the inline picker open/closed. On first open, fetch the voices
  // from ElevenLabs (cached for the rest of the session).
  async function handleToggleVoicePicker() {
    if (showVoicePicker) {
      setShowVoicePicker(false);
      return;
    }
    setVoicePickerError(null);
    setShowVoicePicker(true);
    if (!voices && !loadingVoices && settings.apiKey) {
      setLoadingVoices(true);
      try {
        const list = await listVoices(settings.apiKey);
        setVoices(list);
      } catch (err) {
        setVoicePickerError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingVoices(false);
      }
    }
  }

  function chooseVoice(id: string) {
    const v = voices?.find((x) => x.voice_id === id);
    if (!v) return;
    setVoiceId(v.voice_id);
    setVoiceName(v.name);
    saveVoice(v.voice_id, v.name);
    setShowVoicePicker(false);
  }

  function changeSpeed(next: number) {
    // The slider is `step=0.05`, but float math sometimes produces values
    // like 0.7500000000000001. Round to 2 decimals to keep the UI tidy and
    // localStorage clean — saveSpeed also rounds, but doing it here keeps
    // the React state value matching what we persist.
    const rounded = Math.round(next * 100) / 100;
    const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, rounded));
    setSpeed(clamped);
    saveSpeed(clamped);
  }

  const wrongOutput = looksLikeLaptopSpeakers(outputDeviceLabel);

  return (
    <div className="flex-1 flex flex-col">
      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 text-xs text-slate-400">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="flex items-center gap-1">
            <span>Voice:</span>
            <button
              className="text-slate-200 underline decoration-dotted hover:text-sky-300 underline-offset-2"
              onClick={handleToggleVoicePicker}
              title="Click to switch voice"
            >
              {voiceName || "—"}
            </button>
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
              TTFB: <span className="text-slate-200">{lastLatencyMs}ms</span>
            </span>
          )}
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoSend}
              onChange={toggleAutoSend}
              className="accent-sky-500"
            />
            <span>Auto-send on .?!</span>
          </label>
          <label
            className="flex items-center gap-2 select-none"
            title="Speech rate. 1.00× = unchanged. Below 1× is slower, above 1× is faster. Range: 0.7×–1.2×. Double-click to reset to default."
          >
            <span>Speed:</span>
            <input
              type="range"
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={0.05}
              value={speed}
              onChange={(e) => changeSpeed(Number(e.target.value))}
              onDoubleClick={() => changeSpeed(SPEED_DEFAULT)}
              className="w-24 accent-sky-500"
            />
            <span className="text-slate-200 tabular-nums w-10 text-right">
              {speed.toFixed(2)}×
            </span>
          </label>
        </div>
        <button
          className="text-slate-400 hover:text-slate-200"
          onClick={onOpenSettings}
        >
          Settings
        </button>
      </div>

      {/* Inline voice picker — opened by clicking the voice name above. */}
      {showVoicePicker && (
        <div className="bg-slate-800 border-b border-slate-700 px-4 py-2 text-xs flex items-center gap-2 flex-wrap">
          <span className="text-slate-400">Pick voice:</span>
          {loadingVoices ? (
            <span className="text-slate-400">Loading...</span>
          ) : voicePickerError ? (
            <span className="text-rose-300">Error: {voicePickerError}</span>
          ) : voices ? (
            <select
              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100"
              value={voiceId}
              onChange={(e) => chooseVoice(e.target.value)}
            >
              <option value="">— Select —</option>
              {voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                  {v.category === "cloned" ? "  (cloned)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-slate-400">No voices loaded.</span>
          )}
          <button
            className="text-slate-400 hover:text-slate-200"
            onClick={() => setShowVoicePicker(false)}
          >
            Close
          </button>
        </div>
      )}

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
          autoSend
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
            : "Speak  (Enter)"}
        </button>
        <button
          className="bg-slate-700 text-slate-100 px-6 py-4 rounded font-medium disabled:opacity-30"
          onClick={handleCancel}
          disabled={state === "idle" && queued === 0}
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
