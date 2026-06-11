/**
 * Helpers for enumerating, deduplicating, and recognizing audio output
 * devices, plus matching saved Phone/Meeting device bindings.
 *
 * setSinkId availability:
 *   - Chromium (Chrome/Edge) — AudioContext.setSinkId works since ~Chrome 110.
 *   - Firefox / Safari — no AudioContext.setSinkId. Fallback: route audio
 *     through an <audio> element and call HTMLMediaElement.setSinkId on it.
 *
 * Note: the app always renders its own device list (no native
 * selectAudioOutput picker) — `selectAudioOutput` isn't enabled by default in
 * Edge/Chrome, so the in-app list is what every user actually sees, and one
 * consistent UI lets us relabel/curate devices.
 */

export interface AudioDevice {
  deviceId: string;
  label: string;
}

/** A saved "this device = Phone call / Meeting" binding. */
export interface DeviceBinding {
  deviceId: string;
  label: string;
}

/**
 * Enumerate audio output devices, hiding Chromium's "Default -" and
 * "Communications -" alias entries (deviceId "default" / "communications"),
 * which duplicate real devices and inflate the list. If filtering would
 * somehow leave nothing (unexpected), return the unfiltered list.
 */
export async function listOutputDevices(): Promise<AudioDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const outputs = devices
    .filter((d) => d.kind === "audiooutput")
    .map((d) => ({
      deviceId: d.deviceId,
      // Some browsers return empty labels until permission is granted.
      label: d.label || "Audio output",
    }));
  const deduped = outputs.filter(
    (d) => d.deviceId !== "default" && d.deviceId !== "communications",
  );
  return deduped.length > 0 ? deduped : outputs;
}

/**
 * Request microphone permission for the sole purpose of unlocking device
 * labels in enumerateDevices. We immediately stop the tracks — we never
 * actually record.
 */
export async function primeDevicePermissions(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Swallow — labels will just be blank. Not fatal.
  }
}

/**
 * Apply a deviceId to an AudioContext. Returns true on success.
 */
export async function applySinkToAudioContext(
  ctx: AudioContext,
  deviceId: string,
): Promise<boolean> {
  const withSink = ctx as AudioContext & {
    setSinkId?: (id: string) => Promise<void>;
  };
  if (typeof withSink.setSinkId === "function") {
    try {
      await withSink.setSinkId(deviceId);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Virtual-cable recognition
// ---------------------------------------------------------------------------

/**
 * Known virtual-audio products and their deterministic device-name
 * substrings. These are software products, so the names are identical on
 * every machine that installs them — unlike hardware, which varies.
 *
 * This is a convenience layer only, never a gate: unrecognized devices are
 * always still listed and manually bindable.
 *
 *   Windows: VB-Cable ("CABLE Input (VB-Audio Virtual Cable)"),
 *            VoiceMeeter ("VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)")
 *   macOS:   BlackHole ("BlackHole 2ch"/"16ch"), VB-Cable for Mac
 *            ("VB-Cable"), Rogue Amoeba Loopback ("Loopback Audio" default,
 *            user-renamable), legacy Soundflower
 *   Linux:   PulseAudio/PipeWire null sinks are user-named — no reliable
 *            match; users fall back to manual binding.
 */
const VIRTUAL_CABLE_HINTS = [
  "cable input", // VB-Cable (Windows) — the *input* side is the output device
  "voicemeeter input", // VoiceMeeter VAIO
  "voicemeeter aux input", // VoiceMeeter AUX
  "voicemeeter vaio3", // VoiceMeeter Potato third bus
  "vb-cable", // VB-Cable (macOS)
  "blackhole", // BlackHole (macOS)
  "loopback audio", // Rogue Amoeba Loopback default name
  "soundflower", // legacy macOS
];

/**
 * True if this device label looks like a virtual audio cable — i.e. the kind
 * of device a meeting app reads as a microphone. Used to suggest the
 * "Meeting" binding during onboarding/binding UI.
 */
export function looksLikeVirtualCable(label: string): boolean {
  if (!label) return false;
  const normalized = label.toLowerCase();
  return VIRTUAL_CABLE_HINTS.some((hint) => normalized.includes(hint));
}

// ---------------------------------------------------------------------------
// Binding matching
// ---------------------------------------------------------------------------

/**
 * Normalize a device label for fuzzy comparison. Windows re-enumerates
 * devices with a numeric prefix — "Speakers (3- Realtek(R) Audio)" — and
 * that counter can change across reboots/driver updates, so strip it.
 */
function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\b\d+-\s*/g, "") // "(3- Realtek" → "(Realtek"
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the currently-connected device matching a saved binding.
 * Match by deviceId first (stable per-origin in Chromium unless site data is
 * cleared), then fall back to normalized-label match (survives deviceId
 * resets and Windows renumbering). Returns null if the device isn't present.
 */
export function findBoundDevice(
  devices: AudioDevice[],
  binding: DeviceBinding | null,
): AudioDevice | null {
  if (!binding) return null;
  const byId = devices.find((d) => d.deviceId === binding.deviceId);
  if (byId) return byId;
  const target = normalizeLabel(binding.label);
  if (!target) return null;
  return devices.find((d) => normalizeLabel(d.label) === target) ?? null;
}
