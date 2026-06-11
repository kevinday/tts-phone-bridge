import { useEffect, useRef, useState } from "react";
import {
  findBoundDevice,
  listOutputDevices,
  looksLikeVirtualCable,
  primeDevicePermissions,
  type AudioDevice,
} from "../lib/audioOutput";
import { saveBinding, type BindingSlot, type DeviceBinding } from "../lib/settings";

/**
 * Guided output onboarding (the wizard's "Output" step).
 *
 * Instead of asking a non-technical user to pick from a list of cryptic
 * device names, this walks the two real use cases:
 *
 *   1. Meetings (Teams/Meet/Zoom) — needs a virtual audio cable. Virtual
 *      cables are software products with deterministic device names on every
 *      machine (VB-Cable, VoiceMeeter, BlackHole, …), so we can recognize
 *      one automatically, or guide the install if none is present.
 *
 *   2. Phone calls — the phone-side hardware varies, so we identify it by
 *      WHEN it appears, not what it's named: ask the user to plug it in and
 *      diff the device list on the browser's `devicechange` event.
 *
 * Both paths end in a saved Phone/Meeting binding (same storage the main
 * screen's quick buttons use). The full device list remains available as a
 * manual fallback — recognition is a convenience, never a gate.
 */

interface Props {
  /** Called when the user picks which bound device to use right now. */
  onUseDevice: (device: AudioDevice) => void;
  /** The currently selected output (for highlighting). */
  currentDeviceId: string;
}

export function OnboardingOutputs({ onUseDevice, currentDeviceId }: Props) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [phoneBinding, setPhoneBinding] = useState<DeviceBinding | null>(null);
  const [meetingBinding, setMeetingBinding] = useState<DeviceBinding | null>(
    null,
  );
  // Newly-appeared output device (plug-in detection), if any.
  const [detected, setDetected] = useState<AudioDevice | null>(null);
  const [listening, setListening] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const knownIdsRef = useRef<Set<string>>(new Set());

  async function refresh(): Promise<AudioDevice[]> {
    const list = await listOutputDevices();
    setDevices(list);
    return list;
  }

  // Initial enumeration + devicechange subscription.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await primeDevicePermissions();
      const list = await listOutputDevices();
      if (cancelled) return;
      setDevices(list);
      knownIdsRef.current = new Set(list.map((d) => d.deviceId));
    })();

    const onChange = async () => {
      const list = await listOutputDevices();
      if (cancelled) return;
      setDevices(list);
      const fresh = list.filter((d) => !knownIdsRef.current.has(d.deviceId));
      knownIdsRef.current = new Set(list.map((d) => d.deviceId));
      // A device that just appeared while we're listening is almost certainly
      // the phone interface the user was asked to plug in.
      if (fresh.length > 0) {
        setDetected(fresh[0]);
        setListening(false);
      }
    };

    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
    };
  }, []);

  const virtualCable = devices.find((d) => looksLikeVirtualCable(d.label)) ?? null;
  const phoneDevice = findBoundDevice(devices, phoneBinding);
  const meetingDevice = findBoundDevice(devices, meetingBinding);

  function bind(slot: BindingSlot, device: AudioDevice) {
    const binding = { deviceId: device.deviceId, label: device.label };
    saveBinding(slot, binding);
    if (slot === "phone") setPhoneBinding(binding);
    else setMeetingBinding(binding);
  }

  return (
    <div className="space-y-4">
      {/* ---- Phone calls card ---- */}
      <div className="bg-slate-800 border border-slate-700 rounded p-4 space-y-3">
        <p className="text-slate-200 font-medium">📞 Phone calls</p>
        {phoneBinding ? (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-emerald-400 text-sm">
              ✓ Saved: <code>{phoneBinding.label}</code>
            </span>
            {phoneDevice && (
              <button
                className={[
                  "px-3 py-2 rounded text-sm font-medium",
                  phoneDevice.deviceId === currentDeviceId
                    ? "bg-sky-500 text-slate-900"
                    : "bg-slate-700 hover:bg-slate-600 text-slate-100",
                ].join(" ")}
                onClick={() => onUseDevice(phoneDevice)}
              >
                {phoneDevice.deviceId === currentDeviceId
                  ? "✓ Using for the test"
                  : "Use this for the test"}
              </button>
            )}
            <button
              className="text-xs text-slate-400 underline"
              onClick={() => {
                saveBinding("phone", null);
                setPhoneBinding(null);
                setDetected(null);
              }}
            >
              undo
            </button>
          </div>
        ) : detected ? (
          <div className="space-y-2 text-sm">
            <p className="text-emerald-400">
              ✓ New device detected: <code>{detected.label}</code>
            </p>
            <div className="flex items-center gap-3">
              <button
                className="bg-sky-500 text-slate-900 px-3 py-2 rounded font-medium"
                onClick={() => bind("phone", detected)}
              >
                Yes — use this for phone calls
              </button>
              <button
                className="text-slate-400 text-xs underline"
                onClick={() => setDetected(null)}
              >
                No, that's not it
              </button>
            </div>
          </div>
        ) : listening ? (
          <div className="text-sm text-slate-400 space-y-2">
            <p className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500"></span>
              </span>
              Waiting… plug the phone audio interface (USB) into this computer
              now.
            </p>
            <p className="text-xs">
              Already plugged in? Unplug it, wait two seconds, and plug it back
              in — we spot it the moment it appears.
            </p>
            <button
              className="text-xs text-slate-400 underline"
              onClick={() => setListening(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="space-y-2 text-sm text-slate-400">
            <p>
              We'll find your phone cable automatically — no need to know its
              name.
            </p>
            <button
              className="bg-slate-700 hover:bg-slate-600 text-slate-100 px-3 py-2 rounded font-medium"
              onClick={() => setListening(true)}
            >
              Find my phone cable
            </button>
          </div>
        )}
      </div>

      {/* ---- Meetings card ---- */}
      <div className="bg-slate-800 border border-slate-700 rounded p-4 space-y-3">
        <p className="text-slate-200 font-medium">
          💻 Video meetings (Teams, Meet, Zoom)
        </p>
        {meetingBinding ? (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-emerald-400 text-sm">
              ✓ Saved: <code>{meetingBinding.label}</code>
            </span>
            {meetingDevice && (
              <button
                className={[
                  "px-3 py-2 rounded text-sm font-medium",
                  meetingDevice.deviceId === currentDeviceId
                    ? "bg-sky-500 text-slate-900"
                    : "bg-slate-700 hover:bg-slate-600 text-slate-100",
                ].join(" ")}
                onClick={() => onUseDevice(meetingDevice)}
              >
                {meetingDevice.deviceId === currentDeviceId
                  ? "✓ Using for the test"
                  : "Use this for the test"}
              </button>
            )}
            <button
              className="text-xs text-slate-400 underline"
              onClick={() => {
                saveBinding("meeting", null);
                setMeetingBinding(null);
              }}
            >
              undo
            </button>
          </div>
        ) : virtualCable ? (
          <div className="space-y-2 text-sm">
            <p className="text-emerald-400">
              ✓ Found a virtual audio cable: <code>{virtualCable.label}</code>
            </p>
            <button
              className="bg-sky-500 text-slate-900 px-3 py-2 rounded font-medium"
              onClick={() => bind("meeting", virtualCable)}
            >
              Use this for meetings
            </button>
            <p className="text-xs text-slate-400">
              In the meeting app, set the <em>microphone</em> to the matching
              "CABLE Output" / cable device. Details are in the Guide.
            </p>
          </div>
        ) : (
          <div className="space-y-2 text-sm text-slate-400">
            <p>
              No virtual audio cable found. Meetings need one (free, one-time
              install):
            </p>
            <ul className="list-disc ml-5 space-y-1 text-xs">
              <li>
                Windows:{" "}
                <a
                  href="https://vb-audio.com/Cable/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sky-400 underline"
                >
                  VB-Cable
                </a>{" "}
                — install, then reboot.
              </li>
              <li>
                Mac:{" "}
                <a
                  href="https://existential.audio/blackhole/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sky-400 underline"
                >
                  BlackHole
                </a>{" "}
                (2ch).
              </li>
            </ul>
            <div className="flex items-center gap-3">
              <button
                className="bg-slate-700 hover:bg-slate-600 text-slate-100 px-3 py-2 rounded text-xs"
                onClick={() => void refresh()}
              >
                Rescan
              </button>
              <span className="text-xs">
                Skip this if you only make phone calls.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ---- Manual fallback ---- */}
      <details
        className="text-xs text-slate-500"
        open={showManual}
        onToggle={(e) => setShowManual((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer">
          Or pick a device manually from the full list
        </summary>
        <div className="mt-2 space-y-1">
          {devices.map((d) => (
            <div key={d.deviceId} className="flex items-center gap-2">
              <span className="flex-1 truncate text-slate-300">{d.label}</span>
              <button
                className="border border-slate-600 rounded px-1.5 py-0.5 hover:text-slate-200"
                onClick={() => bind("phone", d)}
              >
                Set 📞
              </button>
              <button
                className="border border-slate-600 rounded px-1.5 py-0.5 hover:text-slate-200"
                onClick={() => bind("meeting", d)}
              >
                Set 💻
              </button>
              <button
                className="border border-slate-600 rounded px-1.5 py-0.5 hover:text-slate-200"
                onClick={() => onUseDevice(d)}
              >
                Use now
              </button>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
