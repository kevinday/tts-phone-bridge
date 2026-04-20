import { useCallback, useEffect, useRef, useState } from "react";
import { base64ToPCM16, type AudioPlayer, type PlayerState } from "../lib/audioPlayer";
import { openSpeakStream, type StreamHandle } from "../lib/elevenlabs";
import { looksLikeLaptopSpeakers } from "../lib/audioOutput";
import { type Settings } from "../lib/settings";

interface Props {
  player: AudioPlayer;
  settings: Settings;
  onOpenSettings: () => void;
}

export function SpeakScreen({ player, settings, onOpenSettings }: Props) {
  const [text, setText] = useState("");
  const [state, setState] = useState<PlayerState>(player.getState());
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [queued, setQueued] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeStreamRef = useRef<StreamHandle | null>(null);
  const sendStartRef = useRef<number | null>(null);

  // Queue for text pressed while a previous utterance is still streaming.
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

  // Focus the textarea on mount & after each send so typing is always primed.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const speak = useCallback(
    (utterance: string) => {
      if (!utterance.trim()) return;
      sendStartRef.current = performance.now();
      setError(null);
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
      stream.send(utterance);
      stream.flushAndClose();
    },
    [settings.apiKey, settings.voiceId, player],
  );

  function handleSend() {
    const utterance = text.trim();
    if (!utterance) return;
    setText("");
    textareaRef.current?.focus();

    if (state === "speaking") {
      queueRef.current.push(utterance);
      setQueued(queueRef.current.length);
    } else {
      speak(utterance);
    }
  }

  function handleCancel() {
    activeStreamRef.current?.abort();
    activeStreamRef.current = null;
    queueRef.current = [];
    setQueued(0);
    player.cancel();
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

  const wrongOutput = looksLikeLaptopSpeakers(settings.outputDeviceLabel);

  return (
    <div className="flex-1 flex flex-col">
      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 text-xs text-slate-400">
        <div className="flex items-center gap-4">
          <span>
            Voice: <span className="text-slate-200">{settings.voiceName || "—"}</span>
          </span>
          <span>
            Output: <span className="text-slate-200">{settings.outputDeviceLabel || "—"}</span>
          </span>
          {lastLatencyMs !== null && (
            <span>
              TTFB: <span className="text-slate-200">{lastLatencyMs}ms</span>
            </span>
          )}
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

      {/* Big textarea — the whole middle of the screen. */}
      <textarea
        ref={textareaRef}
        className="flex-1 w-full bg-slate-900 text-slate-100 text-2xl sm:text-3xl p-6 resize-none outline-none leading-relaxed"
        placeholder="Type what you want to say, then press Enter..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      {/* Bottom action bar */}
      <div className="flex items-center gap-3 p-4 border-t border-slate-800">
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
    </div>
  );
}
