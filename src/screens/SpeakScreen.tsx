import { useCallback, useEffect, useRef, useState } from "react";
import { base64ToPCM16, type AudioPlayer, type PlayerState } from "../lib/audioPlayer";
import { openSpeakStream, type StreamHandle } from "../lib/elevenlabs";
import { looksLikeLaptopSpeakers } from "../lib/audioOutput";
import {
  saveAutoSendPunctuation,
  saveQuickPhrases,
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

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeStreamRef = useRef<StreamHandle | null>(null);
  const sendStartRef = useRef<number | null>(null);

  // Queue for utterances received while a previous one is still streaming.
  const queueRef = useRef<string[]>([]);

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

  // speakOrQueue: fire immediately if idle, otherwise append to queue.
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

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    // Only trigger auto-send when the user is typing new characters at the
    // end — not on e.g. pasting or cursor-in-middle edits. The cheapest heuristic
    // is: the textarea ends with ".?! " now and didn't a moment ago.
    if (autoSend && AUTO_SEND_REGEX.test(next) && !AUTO_SEND_REGEX.test(text)) {
      // Send everything, then clear.
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

  const wrongOutput = looksLikeLaptopSpeakers(settings.outputDeviceLabel);

  return (
    <div className="flex-1 flex flex-col">
      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 text-xs text-slate-400">
        <div className="flex items-center gap-4 flex-wrap">
          <span>
            Voice:{" "}
            <span className="text-slate-200">{settings.voiceName || "—"}</span>
          </span>
          <span>
            Output:{" "}
            <span className="text-slate-200">
              {settings.outputDeviceLabel || "—"}
            </span>
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
        </div>
        <button
          className="text-slate-400 hover:text-slate-200"
          onClick={onOpenSettings}
        >
          Settings
        </button>
      </div>

      {wrongOutput && (
        <div className="bg-amber-500/20 border-b border-amber-500 text-amber-200 px-4 py-2 text-sm">
          ⚠️ Current output looks like laptop speakers, not the phone cable.
          Open Settings to pick the right device.
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
            onClick={() => speakOrQueue(phrase)}
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
