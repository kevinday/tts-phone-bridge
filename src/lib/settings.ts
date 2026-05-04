/**
 * localStorage wrapper for all persisted settings.
 *
 * Security note: the ElevenLabs API key lives in localStorage on the user's
 * own machine. This is acceptable for a dedicated, single-user device (the
 * intended deployment) but should not be used on a shared computer. The
 * setup wizard surfaces this caveat.
 */

const KEY_API_KEY = "ttsb.apiKey";
const KEY_VOICE_ID = "ttsb.voiceId";
const KEY_VOICE_NAME = "ttsb.voiceName";
const KEY_OUTPUT_DEVICE_ID = "ttsb.outputDeviceId";
const KEY_OUTPUT_DEVICE_LABEL = "ttsb.outputDeviceLabel";
const KEY_SETUP_COMPLETED = "ttsb.setupCompleted";
const KEY_QUICK_PHRASES = "ttsb.quickPhrases";
const KEY_AUTO_SEND_PUNCTUATION = "ttsb.autoSendPunctuation";

export interface Settings {
  apiKey: string;
  voiceId: string;
  voiceName: string;
  outputDeviceId: string;
  outputDeviceLabel: string;
  setupCompleted: boolean;
  quickPhrases: string[];
  autoSendPunctuation: boolean;
}

export const DEFAULT_QUICK_PHRASES = [
  "Yes",
  "No",
  "Thank you",
  "One moment please",
  "Could you repeat that?",
  "I'm sorry",
  "Goodbye",
];

export function loadSettings(): Settings {
  return {
    apiKey: localStorage.getItem(KEY_API_KEY) ?? "",
    voiceId: localStorage.getItem(KEY_VOICE_ID) ?? "",
    voiceName: localStorage.getItem(KEY_VOICE_NAME) ?? "",
    outputDeviceId: localStorage.getItem(KEY_OUTPUT_DEVICE_ID) ?? "",
    outputDeviceLabel: localStorage.getItem(KEY_OUTPUT_DEVICE_LABEL) ?? "",
    setupCompleted: localStorage.getItem(KEY_SETUP_COMPLETED) === "true",
    quickPhrases: loadQuickPhrases(),
    // Default ON — matches the auto-send-on-punctuation recommendation for
    // fluent typists. Users can disable via the status-bar toggle.
    autoSendPunctuation:
      (localStorage.getItem(KEY_AUTO_SEND_PUNCTUATION) ?? "true") === "true",
  };
}

function loadQuickPhrases(): string[] {
  const raw = localStorage.getItem(KEY_QUICK_PHRASES);
  if (!raw) return DEFAULT_QUICK_PHRASES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_QUICK_PHRASES;
}

export function saveApiKey(apiKey: string): void {
  localStorage.setItem(KEY_API_KEY, apiKey);
}

export function saveVoice(voiceId: string, voiceName: string): void {
  localStorage.setItem(KEY_VOICE_ID, voiceId);
  localStorage.setItem(KEY_VOICE_NAME, voiceName);
}

export function saveOutputDevice(deviceId: string, label: string): void {
  localStorage.setItem(KEY_OUTPUT_DEVICE_ID, deviceId);
  localStorage.setItem(KEY_OUTPUT_DEVICE_LABEL, label);
}

export function markSetupCompleted(): void {
  localStorage.setItem(KEY_SETUP_COMPLETED, "true");
}

export function clearSetupCompleted(): void {
  localStorage.removeItem(KEY_SETUP_COMPLETED);
}

export function saveQuickPhrases(phrases: string[]): void {
  localStorage.setItem(KEY_QUICK_PHRASES, JSON.stringify(phrases));
}

export function saveAutoSendPunctuation(enabled: boolean): void {
  localStorage.setItem(KEY_AUTO_SEND_PUNCTUATION, enabled ? "true" : "false");
}
