import { useEffect, useMemo, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { loadSettings, type Settings } from "./lib/settings";
import { createAudioPlayer, type AudioPlayer } from "./lib/audioPlayer";
import { SetupWizard } from "./screens/SetupWizard";
import { SpeakScreen } from "./screens/SpeakScreen";

type View = "wizard" | "speak";

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [view, setView] = useState<View>(() =>
    loadSettings().setupCompleted ? "speak" : "wizard",
  );

  // Single long-lived AudioPlayer. Re-using the same AudioContext across
  // utterances avoids the per-utterance `setSinkId` + `resume` latency hit.
  const player = useMemo<AudioPlayer>(() => createAudioPlayer(), []);

  // Apply the saved output device as soon as we know one.
  useEffect(() => {
    if (settings.outputDeviceId) {
      void player.setSink(settings.outputDeviceId);
    }
  }, [settings.outputDeviceId, player]);

  // PWA update prompt.
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });

  function refreshSettings() {
    setSettings(loadSettings());
  }

  return (
    <div className="min-h-full flex flex-col bg-slate-900 text-slate-100">
      {needRefresh && (
        <div className="bg-amber-500 text-slate-900 px-4 py-2 text-sm flex items-center justify-between">
          <span>A new version is available.</span>
          <button
            className="ml-4 font-semibold underline"
            onClick={() => updateServiceWorker(true)}
          >
            Reload
          </button>
        </div>
      )}

      {view === "wizard" ? (
        <SetupWizard
          player={player}
          onComplete={() => {
            refreshSettings();
            setView("speak");
          }}
        />
      ) : (
        <SpeakScreen
          player={player}
          settings={settings}
          onOpenSettings={() => setView("wizard")}
        />
      )}
    </div>
  );
}
