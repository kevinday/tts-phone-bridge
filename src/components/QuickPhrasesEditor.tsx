import { useEffect, useState } from "react";

interface Props {
  initial: string[];
  onClose: () => void;
  onSave: (phrases: string[]) => void;
}

/**
 * Simple modal editor. Lets the user add, rename, delete, and reorder their
 * quick-phrase buttons. Changes are committed only on Save so Cancel is safe.
 */
export function QuickPhrasesEditor({ initial, onClose, onSave }: Props) {
  const [phrases, setPhrases] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function addPhrase() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setPhrases([...phrases, trimmed]);
    setDraft("");
  }

  function updatePhrase(i: number, value: string) {
    const next = phrases.slice();
    next[i] = value;
    setPhrases(next);
  }

  function deletePhrase(i: number) {
    setPhrases(phrases.filter((_, idx) => idx !== i));
  }

  function movePhrase(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= phrases.length) return;
    const next = phrases.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setPhrases(next);
  }

  function handleSave() {
    // Drop any empties left by edits.
    const cleaned = phrases.map((p) => p.trim()).filter(Boolean);
    onSave(cleaned);
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-800 border border-slate-700 rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-medium">Edit quick phrases</h2>
          <button
            className="text-slate-400 hover:text-slate-200"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="p-4 flex-1 overflow-auto space-y-2">
          {phrases.length === 0 && (
            <p className="text-sm text-slate-400">
              No phrases yet. Add one below.
            </p>
          )}
          {phrases.map((phrase, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm"
                value={phrase}
                onChange={(e) => updatePhrase(i, e.target.value)}
              />
              <button
                className="text-slate-400 hover:text-slate-200 px-2"
                disabled={i === 0}
                onClick={() => movePhrase(i, -1)}
                title="Move up"
              >
                ↑
              </button>
              <button
                className="text-slate-400 hover:text-slate-200 px-2"
                disabled={i === phrases.length - 1}
                onClick={() => movePhrase(i, 1)}
                title="Move down"
              >
                ↓
              </button>
              <button
                className="text-rose-400 hover:text-rose-300 px-2"
                onClick={() => deletePhrase(i)}
                title="Delete"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-slate-700 space-y-3">
          <div className="flex items-center gap-2">
            <input
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm"
              placeholder="New phrase..."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPhrase();
                }
              }}
            />
            <button
              className="bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded text-sm"
              onClick={addPhrase}
              disabled={!draft.trim()}
            >
              Add
            </button>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              className="text-slate-400 hover:text-slate-200 px-3 py-1 text-sm"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="bg-sky-500 text-slate-900 px-4 py-1 rounded text-sm font-medium"
              onClick={handleSave}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
