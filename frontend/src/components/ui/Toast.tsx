import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

type Tone = "success" | "error" | "warning" | "info";
interface ToastItem { id: number; tone: Tone; title: string; message?: ReactNode }

const Ctx = createContext<(t: Omit<ToastItem, "id">) => void>(() => {});

const STYLE: Record<Tone, { bar: string; icon: ReactNode }> = {
  success: { bar: "bg-success", icon: <Icon.check className="text-success-text" /> },
  error: { bar: "bg-danger", icon: <Icon.alert className="text-danger" /> },
  warning: { bar: "bg-warning", icon: <Icon.alert className="text-warning-text" /> },
  info: { bar: "bg-primary", icon: <Icon.info className="text-primary" /> },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    window.setTimeout(() => dismiss(id), t.tone === "error" ? 7000 : 4500);
  }, [dismiss]);

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite" role="status">
        {items.map((t) => (
          <div key={t.id} className="animate-toast-in pointer-events-auto flex overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow-pop)]">
            <span className={`w-1 shrink-0 ${STYLE[t.tone].bar}`} />
            <div className="flex flex-1 gap-2.5 px-3.5 py-3">
              <span className="mt-0.5">{STYLE[t.tone].icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text">{t.title}</p>
                {t.message && <div className="mt-0.5 text-[13px] text-muted">{t.message}</div>}
              </div>
              <button type="button" aria-label="Dismiss" className="h-6 w-6 shrink-0 rounded text-muted hover:bg-subtle hover:text-text" onClick={() => dismiss(t.id)}>
                <Icon.close size={14} className="mx-auto" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
