interface StepperProps {
  steps: string[];
  current: number; // 0-indexed
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <ol className="flex items-center gap-2 text-xs mb-8">
      {steps.map((label, i) => {
        const state =
          i < current ? "done" : i === current ? "active" : "pending";
        return (
          <li key={label} className="flex items-center gap-2">
            <div
              className={[
                "w-7 h-7 rounded-full flex items-center justify-center font-semibold",
                state === "done" && "bg-emerald-500 text-slate-900",
                state === "active" && "bg-sky-400 text-slate-900",
                state === "pending" && "bg-slate-700 text-slate-400",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {state === "done" ? "✓" : i + 1}
            </div>
            <span
              className={
                state === "active" ? "text-slate-100" : "text-slate-400"
              }
            >
              {label}
            </span>
            {i < steps.length - 1 && (
              <span className="mx-2 text-slate-700">›</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
