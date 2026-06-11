import { useCallback, useEffect, useRef, useState } from "react";
import { base64ToPCM16, type AudioPlayer, type PlayerState } from "../lib/audioPlayer";
import {
  listVoices,
  openSpeakStream,
  type StreamHandle,
  type Voice,
} from "../lib/elevenlabs";
import {
  findBoundDevice,
  listOutputDevices,
  looksLikeVirtualCable,
  primeDevicePermissions,
  type AudioDevice,
} from "../lib/audioOutput";
import {
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  saveAutoSendPunctuation,
  saveBinding,
  saveOutputDevice,
  saveQuickPhrases,
  saveSpeed,
  saveVoice,
  type BindingSlot,
  type DeviceBinding,
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

// How many recent utterances the on-screen history keeps. The patient can't
// hear his own TTS on phone calls, so the history is his record of what was
// actually said (and whether it played successfully).
const HISTORY_MAX = 5;

interface HistoryEntry {
  id: number;
  text: string;
  status: "pending" | "ok" | "error";
}

export function SpeakScreen({ player, settings, onOpenSettings }: Props) {
  const [text, setText] = useState("");
  const [state, setState] = useState<PlayerState>(player.getState());
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [queued, setQueued] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastUtterance, setLastUtterance] = useState<string>("");

  // Recent utterances, oldest first. Entries are added when an utterance
  // actually starts speaking and updated to ok/error when it finishes.
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const historyIdRef = useRef(0);
  const historyEndRef = useRef<HTMLDivElement | null>(null);

  // Local-only mirrors so the UI updates immediately when the user flips them;
  // the persisted settings object is the source of truth on reload.
  const [autoSend, setAutoSend] = useState(settings.autoSendPunctuation);
  const [quickPhrases, setQuickPhrases] = useState(settings.quickPhrases);
  const [showEditor, setShowEditor] = useState(false);

  // Output device — changeable from the typing screen (switching between
  // the phone chain and a virtual audio cable for Teams/Meet several times a
  // day). The app always renders its own picker panel: selectAudioOutput
  // isn't enabled by default in Edge/Chrome, so a native picker would never
  // show for the patient anyway, and our own panel lets us offer the bound
  // Phone/Meeting quick buttons and a curated list.
  const [outputDeviceId, setOutputDeviceId] = useState(settings.outputDeviceId);
  const [outputDeviceLabel, setOutputDeviceLabel] = useState(
    settings.outputDeviceLabel,
  );
  const [outputPickerError, setOutputPickerError] = useState<string | null>(null);
  const [showOutputPanel, setShowOutputPanel] = useState(false);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  // Phone/Meeting quick-output bindings. Optional: when neither is bound the
  // panel is just the (deduplicated) device list, same as before.
  const [phoneBinding, setPhoneBinding] = useState<DeviceBinding | null>(
    settings.phoneDevice,
  );
  const [meetingBinding, setMeetingBinding] = useState<DeviceBinding | null>(
    settings.meetingDevice,
  );
  // When bindings exist the full list is collapsed behind "More devices…".
  const [showAllDevices, setShowAllDevices] = useState(false);

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

  // Keep the newest history entry in view.
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [history]);

  // ---------- History helpers ----------
  function pushHistory(text: string): number {
    const id = ++historyIdRef.current;
    const entry: HistoryEntry = { id, text, status: "pending" };
    setHistory((prev) => [...prev, entry].slice(-HISTORY_MAX));
    return id;
  }

  function setHistoryStatus(id: number, status: HistoryEntry["status"]) {
    setHistory((prev) =>
      prev.map((h) => (h.id === id ? { ...h, status } : h)),
    );
  }

  // ---------- Speak path ----------
  const speak = useCallback(
    (utterance: string) => {
      const trimmed = utterance.trim();
      if (!trimmed) return;
      sendStartRef.current = performance.now();
      setError(null);
      setLastUtterance(trimmed);
      const historyId = pushHistory(trimmed);
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
          setHistoryStatus(historyId, "ok");
          // If more utterances queued up, fire the next one.
          const next = queueRef.current.shift();
          setQueued(queueRef.current.length);
          if (next) speak(next);
        },
        onError: (err) => {
          setError(err.message);
          player.cancel();
          activeStreamRef.current = null;
          setHistoryStatus(historyId, "error");
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

  function handleHistoryClick(entry: HistoryEntry) {
    void speakOrQueue(entry.text);
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

  // ---------- Output device panel ----------
  const hasBindings = phoneBinding !== null || meetingBinding !== null;
  const phoneDevice = findBoundDevice(devices, phoneBinding);
  const meetingDevice = findBoundDevice(devices, meetingBinding);

  async function handleToggleOutputPanel() {
    setOutputPickerError(null);
    if (showOutputPanel) {
      setShowOutputPanel(false);
      return;
    }
    await primeDevicePermissions();
    setDevices(await listOutputDevices());
    setShowAllDevices(false);
    setShowOutputPanel(true);
  }

  async function selectDevice(device: AudioDevice, closePanel = true) {
    await player.resume();
    const ok = await player.setSink(device.deviceId);
    setOutputDeviceId(device.deviceId);
    setOutputDeviceLabel(device.label);
    saveOutputDevice(device.deviceId, device.label);
    if (closePanel) setShowOutputPanel(false);
    if (!ok) {
      setOutputPickerError(
        "Browser couldn't apply the selection — audio may still play through the default output.",
      );
    }
  }

  function isBoundTo(slot: BindingSlot, device: AudioDevice): boolean {
    const bound = slot === "phone" ? phoneDevice : meetingDevice;
    return bound?.deviceId === device.deviceId;
  }

  /** Toggle a device's binding for a slot (re-clicking the bound row unbinds). */
  function toggleBinding(slot: BindingSlot, device: AudioDevice) {
    const next = isBoundTo(slot, device)
      ? null
      : { deviceId: device.deviceId, label: device.label };
    saveBinding(slot, next);
    if (slot === "phone") setPhoneBinding(next);
    else setMeetingBinding(next);
  }

  function isCurrent(device: AudioDevice | null): boolean {
    if (!device) return false;
    return (
      device.deviceId === outputDeviceId || device.label === outputDeviceLabel
    );
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
              onClick={handleToggleOutputPanel}
              title="Click to change where the voice plays (phone cable or meeting)"
            >
              {isCurrent(phoneDevice)
                ? "📞 Phone call"
                : isCurrent(meetingDevice)
                  ? "💻 Meeting"
                  : outputDeviceLabel || "—"}
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
        <div className="flex items-center gap-3">
          <a
            className="text-slate-400 hover:text-slate-200"
            href={`${import.meta.env.BASE_URL}guide.html`}
            target="_blank"
            rel="noopener noreferrer"
            title="Usage instructions, hardware guide, troubleshooting"
          >
            Guide
          </a>
          <button
            className="text-slate-400 hover:text-slate-200"
            onClick={onOpenSettings}
          >
            Settings
          </button>
        </div>
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

      {/* Output panel — quick Phone/Meeting buttons (when bound) + device list. */}
      {showOutputPanel && (
        <div className="bg-slate-800 border-b border-slate-700 px-4 py-3 text-sm space-y-3">
          {hasBindings && (
            <div className="flex items-center gap-3 flex-wrap">
              {phoneBinding && (
                <QuickOutputButton
                  label="📞 Phone call"
                  device={phoneDevice}
                  current={isCurrent(phoneDevice)}
                  onClick={() => phoneDevice && void selectDevice(phoneDevice)}
                />
              )}
              {meetingBinding && (
                <QuickOutputButton
                  label="💻 Meeting"
                  device={meetingDevice}
                  current={isCurrent(meetingDevice)}
                  onClick={() =>
                    meetingDevice && void selectDevice(meetingDevice)
                  }
                />
              )}
              <button
                className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2"
                onClick={() => setShowAllDevices((v) => !v)}
              >
                {showAllDevices ? "Hide device list" : "More devices…"}
              </button>
              <button
                className="text-xs text-slate-400 hover:text-slate-200 ml-auto"
                onClick={() => setShowOutputPanel(false)}
              >
                Close
              </button>
            </div>
          )}

          {(!hasBindings || showAllDevices) && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>
                  Pick where the voice plays. Use 📞/💻 to save a device as a
                  quick button.
                </span>
                {!hasBindings && (
                  <button
                    className="hover:text-slate-200"
                    onClick={() => setShowOutputPanel(false)}
                  >
                    Close
                  </button>
                )}
              </div>
              {devices.length === 0 && (
                <div className="text-xs text-slate-400">No devices found.</div>
              )}
              {devices.map((d) => (
                <div
                  key={d.deviceId}
                  className={[
                    "flex items-center gap-2 rounded px-2 py-1",
                    isCurrent(d) ? "bg-sky-500/15" : "hover:bg-slate-700/50",
                  ].join(" ")}
                >
                  <button
                    className="flex-1 text-left text-slate-100 hover:text-sky-300 truncate"
                    onClick={() => void selectDevice(d)}
                    title="Use this output"
                  >
                    {d.label}
                    {isCurrent(d) && (
                      <span className="text-sky-400 text-xs ml-2">
                        ✓ current
                      </span>
                    )}
                    {looksLikeVirtualCable(d.label) && (
                      <span className="text-slate-400 text-xs ml-2">
                        (virtual cable — good for meetings)
                      </span>
                    )}
                  </button>
                  <button
                    className={[
                      "text-xs rounded px-1.5 py-0.5 border",
                      isBoundTo("phone", d)
                        ? "border-sky-500 bg-sky-500/20 text-sky-300"
                        : "border-slate-600 text-slate-400 hover:text-slate-200",
                    ].join(" ")}
                    onClick={() => toggleBinding("phone", d)}
                    title={
                      isBoundTo("phone", d)
                        ? "This is your Phone call device — click to unset"
                        : "Save as your Phone call device"
                    }
                  >
                    {isBoundTo("phone", d) ? "✓ 📞 Phone" : "Set 📞"}
                  </button>
                  <button
                    className={[
                      "text-xs rounded px-1.5 py-0.5 border",
                      isBoundTo("meeting", d)
                        ? "border-sky-500 bg-sky-500/20 text-sky-300"
                        : "border-slate-600 text-slate-400 hover:text-slate-200",
                    ].join(" ")}
                    onClick={() => toggleBinding("meeting", d)}
                    title={
                      isBoundTo("meeting", d)
                        ? "This is your Meeting device — click to unset"
                        : "Save as your Meeting device"
                    }
                  >
                    {isBoundTo("meeting", d) ? "✓ 💻 Meeting" : "Set 💻"}
                  </button>
                </div>
              ))}
            </div>
          )}
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

      {/* Recent messages — what was said (or failed). Click any to say again. */}
      {history.length > 0 && (
        <div className="px-4 py-2 border-b border-slate-800 max-h-36 overflow-y-auto">
          {history.map((h, i) => {
            const isNewest = i === history.length - 1;
            return (
              <button
                key={h.id}
                className={[
                  "block w-full text-left rounded px-2 py-1 text-sm truncate hover:bg-slate-800",
                  h.status === "error"
                    ? "text-rose-300"
                    : isNewest
                      ? "text-slate-100"
                      : "text-slate-500",
                ].join(" ")}
                onClick={() => handleHistoryClick(h)}
                title={
                  h.status === "error"
                    ? "This didn't play — click to try again"
                    : "Click to say this again"
                }
              >
                <span className="mr-2">
                  {h.status === "error"
                    ? "⚠️"
                    : h.status === "pending"
                      ? "⏳"
                      : "🔊"}
                </span>
                {h.text}
                {h.status === "error" && (
                  <span className="text-xs ml-2">
                    — didn't play, click to retry
                  </span>
                )}
              </button>
            );
          })}
          <div ref={historyEndRef} />
        </div>
      )}

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

function QuickOutputButton({
  label,
  device,
  current,
  onClick,
}: {
  label: string;
  /** The matching connected device, or null if it isn't plugged in / present. */
  device: AudioDevice | null;
  current: boolean;
  onClick: () => void;
}) {
  const connected = device !== null;
  return (
    <button
      className={[
        "px-4 py-3 rounded font-medium text-base",
        current
          ? "bg-sky-500 text-slate-900"
          : connected
            ? "bg-slate-700 hover:bg-slate-600 text-slate-100"
            : "bg-slate-700/40 text-slate-500 cursor-not-allowed",
      ].join(" ")}
      onClick={onClick}
      disabled={!connected}
      title={
        connected
          ? `Switch output to ${device.label}`
          : "Device not connected right now"
      }
    >
      {label}
      {current && <span className="ml-2 text-sm">✓</span>}
      {!connected && (
        <span className="block text-xs font-normal">not connected</span>
      )}
    </button>
  );
}
