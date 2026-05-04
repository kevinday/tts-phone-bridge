import { useEffect, useState } from "react";
import {
  listOutputDevices,
  looksLikeLaptopSpeakers,
  pickOutputDevice,
  primeDevicePermissions,
  type AudioDevice,
} from "../lib/audioOutput";
import {
  base64ToPCM16,
  type AudioPlayer,
  type PlayerState,
} from "../lib/audioPlayer";
import { listVoices, openSpeakStream, type Voice } from "../lib/elevenlabs";
import {
  loadSettings,
  markSetupCompleted,
  saveApiKey,
  saveOutputDevice,
  saveVoice,
} from "../lib/settings";
import { Stepper } from "../components/Stepper";

const STEPS = ["API key", "Voice", "Output", "Test"];

const TEST_SENTENCE =
  "Hello — this is a test of the phone bridge. If you can hear this clearly, we're ready to go.";

interface Props {
  player: AudioPlayer;
  onComplete: () => void;
}

export function SetupWizard({ player, onComplete }: Props) {
  const initial = loadSettings();
  const [step, setStep] = useState(0);

  // Step 1 state
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [testing, setTesting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [voices, setVoices] = useState<Voice[] | null>(null);

  // Step 2 state
  const [voiceId, setVoiceId] = useState(initial.voiceId);
  const [previewing, setPreviewing] = useState(false);

  // Step 3 state
  const [device, setDevice] = useState<AudioDevice | null>(
    initial.outputDeviceId
      ? {
          deviceId: initial.outputDeviceId,
          label: initial.outputDeviceLabel || "Saved output",
        }
      : null,
  );
  const [fallbackDevices, setFallbackDevices] = useState<AudioDevice[]>([]);
  const [sinkApplied, setSinkApplied] = useState<boolean>(() =>
    player.getSinkStatus().applied,
  );
  const hasNativePicker =
    typeof (
      navigator.mediaDevices as unknown as {
        selectAudioOutput?: () => unknown;
      }
    ).selectAudioOutput === "function";

  // Playback / diagnostics state
  const [playerState, setPlayerState] = useState<PlayerState>(player.getState());
  const [volume, setVolumeState] = useState<number>(player.getVolume());
  const [finalSpeaking, setFinalSpeaking] = useState(false);

  useEffect(() => {
    const unsub = player.onStateChange(setPlayerState);
    return () => unsub();
  }, [player]);

  useEffect(() => {
    if (step === 2 && !hasNativePicker) {
      // Firefox/Safari fallback: prime permission so labels populate.
      void primeDevicePermissions().then(async () => {
        setFallbackDevices(await listOutputDevices());
      });
    }
  }, [step, hasNativePicker]);

  // -------- Step 1: API key --------
  async function testApiKey() {
    setTesting(true);
    setApiError(null);
    try {
      const vs = await listVoices(apiKey.trim());
      setVoices(vs);
      saveApiKey(apiKey.trim());
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  // -------- Step 2: Voice preview --------
  async function previewVoice() {
    if (!voiceId) return;
    // Ensure context is resumed by the same user gesture that triggered this.
    await player.resume();
    setPreviewing(true);
    const stream = openSpeakStream({
      apiKey: apiKey.trim(),
      voiceId,
      onAudioChunk: (b64) => player.enqueuePCM16(base64ToPCM16(b64)),
      onDone: () => {
        player.markStreamEnd();
        setPreviewing(false);
      },
      onError: (err) => {
        console.error(err);
        setPreviewing(false);
      },
    });
    stream.send("Hello. This is a preview of the selected voice.");
    stream.flushAndClose();
  }

  function saveVoiceAndAdvance() {
    const v = voices?.find((x) => x.voice_id === voiceId);
    if (!v) return;
    saveVoice(v.voice_id, v.name);
    setStep(2);
  }

  // -------- Step 3: Output device --------
  async function chooseDeviceNative() {
    // Resume context first — some browsers stop showing the picker if the
    // context is suspended.
    await player.resume();
    const picked = await pickOutputDevice();
    if (picked) {
      setDevice(picked);
      const ok = await player.setSink(picked.deviceId);
      setSinkApplied(ok);
    }
  }

  async function chooseDeviceFallback(deviceId: string) {
    await player.resume();
    const d = fallbackDevices.find((x) => x.deviceId === deviceId) ?? null;
    if (d) {
      setDevice(d);
      const ok = await player.setSink(d.deviceId);
      setSinkApplied(ok);
    }
  }

  async function playTestTone() {
    await player.resume();
    // A short, friendly "di-daa" chirp — two tones so "silence vs ambient noise"
    // is unambiguous even at low volume.
    const sampleRate = 16000;
    const total = sampleRate; // 1 second total
    const int16 = new Int16Array(total);
    // 0..0.4s at 660Hz, 0.5..0.9s at 880Hz, silence between.
    for (let i = 0; i < total; i++) {
      const t = i / sampleRate;
      let hz = 0;
      if (t < 0.4) hz = 660;
      else if (t >= 0.5 && t < 0.9) hz = 880;
      // 0.5 amplitude for clearly-audible test tone.
      int16[i] =
        hz === 0
          ? 0
          : Math.round(Math.sin(2 * Math.PI * hz * t) * 0.5 * 32767);
    }
    player.enqueuePCM16(int16);
    player.markStreamEnd();
  }

  function saveDeviceAndAdvance() {
    if (!device) return;
    saveOutputDevice(device.deviceId, device.label);
    setStep(3);
  }

  // -------- Step 4: End-to-end --------
  async function speakFinalTest() {
    await player.resume();
    setFinalSpeaking(true);
    const stream = openSpeakStream({
      apiKey: apiKey.trim(),
      voiceId,
      onAudioChunk: (b64) => player.enqueuePCM16(base64ToPCM16(b64)),
      onDone: () => {
        player.markStreamEnd();
        setFinalSpeaking(false);
      },
      onError: (err) => {
        console.error(err);
        setFinalSpeaking(false);
      },
    });
    stream.send(TEST_SENTENCE);
    stream.flushAndClose();
  }

  function finishSetup() {
    markSetupCompleted();
    onComplete();
  }

  function onVolumeChange(v: number) {
    player.setVolume(v);
    setVolumeState(v);
  }

  const deviceWarn = device && looksLikeLaptopSpeakers(device.label);

  return (
    <div className="flex-1 flex justify-center p-6 sm:p-10">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-semibold mb-1">TTS Phone Bridge — Setup</h1>
        <p className="text-slate-400 text-sm mb-6">
          Four quick steps to verify the app can reach ElevenLabs and route
          audio to the phone cable.
        </p>

        <Stepper steps={STEPS} current={step} />

        {step === 0 && (
          <section className="space-y-4">
            <h2 className="text-lg font-medium">Step 1 — ElevenLabs API key</h2>
            <p className="text-sm text-slate-400">
              Paste the API key from your ElevenLabs account. It's stored in
              this browser only. Don't use this app on a shared computer.
            </p>

            <div className="bg-slate-800 border border-slate-700 rounded p-4 space-y-3">
              <p className="text-sm text-slate-200 font-medium">
                Don't have a key yet?
              </p>
              <ol className="text-sm text-slate-400 list-decimal ml-5 space-y-1">
                <li>
                  Open the{" "}
                  <a
                    href="https://elevenlabs.io/app/settings/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-400 underline"
                  >
                    ElevenLabs API keys page
                  </a>{" "}
                  (sign in if prompted).
                </li>
                <li>
                  Click <span className="text-slate-200">+ Create Key</span>.
                </li>
                <li>
                  Give it a name like <em>Phone Bridge</em> and grant the{" "}
                  <span className="text-slate-200">Text to Speech</span> and{" "}
                  <span className="text-slate-200">Voices (read)</span>{" "}
                  permissions.
                </li>
                <li>
                  Copy the key — it's shown in full <strong>only once</strong>,
                  right after you create it.
                </li>
              </ol>
              <a
                href="https://elevenlabs.io/app/settings/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block bg-slate-700 hover:bg-slate-600 text-slate-100 px-3 py-2 rounded text-sm"
              >
                Open ElevenLabs API keys ↗
              </a>
            </div>

            <input
              type="password"
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-slate-100"
              placeholder="Paste your API key here (starts with sk_...)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
            <div className="flex items-center gap-3">
              <button
                className="bg-sky-500 text-slate-900 px-4 py-2 rounded font-medium disabled:opacity-50"
                disabled={!apiKey.trim() || testing}
                onClick={testApiKey}
              >
                {testing ? "Testing..." : "Test connection"}
              </button>
              {voices && (
                <span className="text-emerald-400 text-sm">
                  ✓ Connected — {voices.length} voices found
                </span>
              )}
              {apiError && (
                <span className="text-rose-400 text-sm">{apiError}</span>
              )}
            </div>
            {voices && (
              <button
                className="bg-slate-700 px-4 py-2 rounded text-sm"
                onClick={() => setStep(1)}
              >
                Next: pick a voice →
              </button>
            )}
          </section>
        )}

        {step === 1 && voices && (
          <section className="space-y-4">
            <h2 className="text-lg font-medium">Step 2 — Pick a voice</h2>
            <p className="text-sm text-slate-400">
              Cloned voices are marked. Use the voice clone of the patient.
            </p>
            <select
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-slate-100"
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
            >
              <option value="">— Select a voice —</option>
              {voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                  {v.category === "cloned" ? "  (cloned)" : ""}
                </option>
              ))}
            </select>
            <VolumeSlider value={volume} onChange={onVolumeChange} />
            {playerState === "speaking" && (
              <PlayingIndicator label="Playing preview..." />
            )}
            <div className="flex items-center gap-3 pt-2">
              <BackButton onClick={() => setStep(0)} />
              <button
                className="bg-slate-700 px-4 py-2 rounded text-sm disabled:opacity-50"
                disabled={!voiceId || previewing}
                onClick={previewVoice}
              >
                {previewing ? "Playing..." : "Preview voice"}
              </button>
              <button
                className="bg-sky-500 text-slate-900 px-4 py-2 rounded font-medium disabled:opacity-50"
                disabled={!voiceId}
                onClick={saveVoiceAndAdvance}
              >
                Next: pick output →
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="space-y-4">
            <h2 className="text-lg font-medium">
              Step 3 — Output device (to phone)
            </h2>
            <p className="text-sm text-slate-400">
              Pick the audio output that's plugged into the attenuator cable →
              phone. <span className="text-amber-300">Not</span> your laptop
              speakers (unless you're just testing without the hardware).
            </p>

            {hasNativePicker ? (
              <button
                className="bg-slate-700 px-4 py-2 rounded"
                onClick={chooseDeviceNative}
              >
                {device ? "Change output device..." : "Choose output device..."}
              </button>
            ) : (
              <select
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-slate-100"
                value={device?.deviceId ?? ""}
                onChange={(e) => chooseDeviceFallback(e.target.value)}
              >
                <option value="">— Select a device —</option>
                {fallbackDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            )}

            {device && (
              <div className="space-y-2">
                <div
                  className={[
                    "p-3 rounded text-sm",
                    deviceWarn
                      ? "bg-amber-500/20 border border-amber-500 text-amber-200"
                      : "bg-slate-800 text-slate-200",
                  ].join(" ")}
                >
                  {deviceWarn && (
                    <strong>⚠️ Looks like laptop speakers — </strong>
                  )}
                  Current: <code>{device.label || "(no label)"}</code>
                </div>
                <div className="text-xs text-slate-400 flex items-center gap-2">
                  <span>Routing:</span>
                  {sinkApplied ? (
                    <span className="text-emerald-400">
                      ✓ setSinkId applied
                    </span>
                  ) : (
                    <span className="text-amber-400">
                      ⚠ setSinkId not supported — audio will play through the
                      browser's default output
                    </span>
                  )}
                </div>
              </div>
            )}

            <VolumeSlider value={volume} onChange={onVolumeChange} />
            {playerState === "speaking" && (
              <PlayingIndicator label="Test tone playing..." />
            )}

            <div className="flex items-center gap-3 pt-2">
              <BackButton onClick={() => setStep(1)} />
              <button
                className="bg-slate-700 px-4 py-2 rounded text-sm disabled:opacity-50"
                disabled={!device}
                onClick={playTestTone}
              >
                Play test tone
              </button>
              <button
                className="bg-sky-500 text-slate-900 px-4 py-2 rounded font-medium disabled:opacity-50"
                disabled={!device}
                onClick={saveDeviceAndAdvance}
              >
                Next: end-to-end test →
              </button>
            </div>

            <details className="text-xs text-slate-500 mt-4">
              <summary className="cursor-pointer">
                Not hearing anything? Expand for troubleshooting
              </summary>
              <ul className="list-disc ml-5 mt-2 space-y-1">
                <li>
                  Check your system output volume (menu bar / volume shortcut).
                </li>
                <li>
                  Some browsers mute tabs by default — click the speaker icon
                  on the tab to unmute.
                </li>
                <li>
                  Click <em>Change output device...</em> again and confirm you
                  selected the right one.
                </li>
                <li>
                  If Routing shows "not supported", your browser doesn't back
                  AudioContext.setSinkId — audio goes to the browser's default
                  output instead of the chosen device.
                </li>
              </ul>
            </details>
          </section>
        )}

        {step === 3 && (
          <section className="space-y-4">
            <h2 className="text-lg font-medium">Step 4 — End-to-end test</h2>
            <p className="text-sm text-slate-400">
              Open a voice-memo app on the phone and start recording. Then
              press Speak. Play the recording back; if it's clear and
              undistorted, you're done.
            </p>
            <VolumeSlider value={volume} onChange={onVolumeChange} />
            {playerState === "speaking" && (
              <PlayingIndicator label="Speaking test phrase..." />
            )}
            <div className="flex items-center gap-3">
              <BackButton onClick={() => setStep(2)} />
              <button
                className="bg-sky-500 text-slate-900 px-4 py-2 rounded font-medium disabled:opacity-50"
                disabled={finalSpeaking}
                onClick={speakFinalTest}
              >
                {finalSpeaking ? "Speaking..." : "Speak test phrase"}
              </button>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                className="bg-emerald-500 text-slate-900 px-4 py-2 rounded font-medium"
                onClick={finishSetup}
              >
                ✓ Sounds good — done
              </button>
              <button
                className="text-slate-400 text-sm underline"
                onClick={() => setStep(2)}
              >
                Sounds bad — redo output step
              </button>
            </div>

            <details className="bg-slate-800 border border-slate-700 rounded p-4 mt-6 text-sm">
              <summary className="cursor-pointer text-slate-200 font-medium">
                Want to use this with Teams, Google Meet, or Zoom too?
              </summary>
              <div className="mt-3 space-y-2 text-slate-400">
                <p>
                  This app's voice clone can speak through any conferencing app
                  that lets you pick a microphone — by routing audio through a{" "}
                  <em>virtual audio cable</em> instead of the physical phone
                  cable.
                </p>
                <p className="text-slate-200 font-medium pt-1">
                  Windows setup (one-time):
                </p>
                <ol className="list-decimal ml-5 space-y-1">
                  <li>
                    Install{" "}
                    <a
                      href="https://vb-audio.com/Cable/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-400 underline"
                    >
                      VB-Cable
                    </a>{" "}
                    (free) and reboot.
                  </li>
                  <li>
                    Back in this app, go to <em>Settings</em> and pick{" "}
                    <code className="text-slate-200">CABLE Input (VB-Audio)</code>{" "}
                    as the output device.
                  </li>
                  <li>
                    In Teams / Meet / Zoom, set the microphone to{" "}
                    <code className="text-slate-200">CABLE Output (VB-Audio)</code>.
                  </li>
                </ol>
                <p className="pt-2">
                  You can keep your phone-cable output saved in Settings and
                  switch back when you need to make a phone call.
                </p>
              </div>
            </details>
          </section>
        )}
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="text-slate-400 hover:text-slate-200 text-sm px-2 py-2"
      onClick={onClick}
    >
      ← Back
    </button>
  );
}

function VolumeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 text-xs text-slate-400">
      <span className="w-16">Volume</span>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-sky-500"
      />
      <span className="w-12 text-right tabular-nums">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

function PlayingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sky-300 text-sm">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500"></span>
      </span>
      {label}
    </div>
  );
}
