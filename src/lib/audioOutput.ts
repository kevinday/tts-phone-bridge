/**
 * Helpers for picking the correct audio output device and warning the user
 * if they picked what looks like laptop speakers instead of the phone-bound
 * cable.
 *
 * setSinkId availability:
 *   - Chromium (Chrome/Edge) — AudioContext.setSinkId works since ~Chrome 110.
 *   - Firefox / Safari — no AudioContext.setSinkId. Fallback: route audio
 *     through an <audio> element and call HTMLMediaElement.setSinkId on it.
 *
 * The patient's environment is Windows Edge, so the Chromium path is primary.
 */

export interface AudioDevice {
  deviceId: string;
  label: string;
}

/**
 * Strings that almost certainly indicate a built-in / wrong output device.
 * We warn (not block) so the user can override if they know better.
 */
const LAPTOP_SPEAKER_HINTS = [
  "built-in",
  "built in",
  "internal speakers",
  "macbook speakers",
  "realtek",
  "speakers (realtek",
  "laptop speakers",
  "default - speakers",
];

export function looksLikeLaptopSpeakers(label: string): boolean {
  if (!label) return false;
  const normalized = label.toLowerCase();
  return LAPTOP_SPEAKER_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * Use the native Chromium picker if available — one click, shows the OS's
 * own device names, returns a deviceId we can pass to setSinkId. Falls back
 * to the first non-default output if the API is missing.
 */
export async function pickOutputDevice(): Promise<AudioDevice | null> {
  // selectAudioOutput is a recent addition; types may not be in lib.dom yet.
  const md = navigator.mediaDevices as MediaDevices & {
    selectAudioOutput?: (opts?: {
      deviceId?: string;
    }) => Promise<MediaDeviceInfo>;
  };

  if (typeof md.selectAudioOutput === "function") {
    try {
      const info = await md.selectAudioOutput();
      return { deviceId: info.deviceId, label: info.label };
    } catch (err) {
      // User dismissed the picker — treat as no-op.
      if ((err as DOMException)?.name === "NotAllowedError") return null;
      throw err;
    }
  }

  // Firefox / Safari fallback: enumerate and let caller render their own UI.
  return null;
}

/**
 * Enumerate audio output devices. The browser hides labels until the user
 * has granted microphone permission *at least once*, which is fine here —
 * the setup wizard will prompt and then re-enumerate.
 */
export async function listOutputDevices(): Promise<AudioDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audiooutput")
    .map((d) => ({
      deviceId: d.deviceId,
      // Some browsers return empty labels until permission is granted.
      label: d.label || "Audio output",
    }));
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
