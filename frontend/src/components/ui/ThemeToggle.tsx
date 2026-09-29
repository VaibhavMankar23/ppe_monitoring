import { useTheme, type ThemePref } from "../../lib/theme";
import { Icon } from "./Icons";

// Two-way appearance: Light for desk work, Console (dark) for a 24/7 wall display.
const OPTIONS: { pref: ThemePref; label: string; icon: typeof Icon.sun }[] = [
  { pref: "light", label: "Light", icon: Icon.sun },
  { pref: "dark", label: "Console", icon: Icon.moon },
];

/**
 * Appearance control. On desktop (lg) a three-way segmented switch (Light / System / Dark);
 * on the collapsed icon rail a single button that cycles through the three.
 */
export function ThemeToggle() {
  const { pref, setPref } = useTheme();

  return (
    <>
      {/* segmented control — desktop */}
      <div className="hidden rounded-lg border border-border bg-subtle p-0.5 lg:flex" role="group" aria-label="Appearance">
        {OPTIONS.map(({ pref: p, label, icon: I }) => (
          <button
            key={p}
            type="button"
            onClick={() => setPref(p)}
            aria-pressed={pref === p}
            title={`${label} theme`}
            className={`inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition-colors ${
              pref === p ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"
            }`}
          >
            <I size={14} /> {label}
          </button>
        ))}
      </div>

      {/* single cycling button — collapsed icon rail */}
      <button
        type="button"
        onClick={() => setPref(OPTIONS[(OPTIONS.findIndex((o) => o.pref === pref) + 1) % OPTIONS.length].pref)}
        title={`Appearance: ${pref} (click to change)`}
        aria-label={`Appearance: ${pref}. Click to change.`}
        className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:bg-subtle hover:text-text lg:hidden"
      >
        {(() => { const I = OPTIONS.find((o) => o.pref === pref)?.icon ?? Icon.monitor; return <I size={17} />; })()}
      </button>
    </>
  );
}
