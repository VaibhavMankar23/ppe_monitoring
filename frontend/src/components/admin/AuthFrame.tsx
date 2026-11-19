import type { ReactNode } from "react";
import { Icon, type IconName } from "../ui";

const POINTS: [IconName, string, string][] = [
  ["monitoring", "Live, on every camera", "Workers are checked continuously; unsafe moments surface in seconds."],
  ["incidents", "Evidence you can trust", "Confirmed across several frames, with the clearest frame kept."],
  ["reports", "Better every week", "Every verdict sharpens the model and the compliance figures."],
];

/**
 * Frame for the screens outside the app (sign in, forced password change): a brand panel on the left
 * (hidden on narrow screens), the form on the right. Same tokens as the app, so light and dark both work.
 */
export function AuthFrame({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main id="main" className="grid min-h-dvh bg-canvas min-[1000px]:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <div className="relative hidden flex-col overflow-hidden border-r border-line bg-surface p-12 min-[1000px]:flex">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-brand" />
        <div className="flex items-center gap-3">
          <img src="/mahindra-logo.png" alt="Mahindra" className="h-[28px] w-auto dark:hidden" />
          <img src="/mahindra-logo-on-dark.png" alt="Mahindra" className="hidden h-[28px] w-auto dark:block" />
          <span className="border-l border-line-strong pl-3 text-sm leading-[1.2] font-semibold text-ink-2">PPE<br />Compliance</span>
        </div>
        <div className="mt-auto">
          <div className="eyebrow mb-3">Safety intelligence</div>
          <h2 className="max-w-[16ch] text-[40px] leading-[1.1] font-bold tracking-[-0.02em] text-ink">Every worker home safe, every shift.</h2>
          <div className="mt-10 grid gap-3">
            {POINTS.map(([icon, t, d]) => (
              <div key={t} className="flex items-start gap-4 rounded-xl border border-line bg-surface-2 p-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><Icon name={icon} size={19} /></span>
                <div><b className="block text-sm font-semibold text-ink">{t}</b><span className="text-[13.5px] text-ink-3">{d}</span></div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="grid place-items-center px-6 py-10">
        <div className="grid w-full max-w-[400px] gap-5">
          <img src="/mahindra-logo.png" alt="Mahindra" className="block h-[28px] w-auto justify-self-start min-[1000px]:hidden dark:hidden" />
          <img src="/mahindra-logo-on-dark.png" alt="" className="hidden h-[28px] w-auto justify-self-start max-[999px]:dark:block" />
          <div>
            <h1 className="text-[28px] leading-tight font-bold tracking-[-0.02em]">{title}</h1>
            {intro && <p className="mt-2 text-sm text-ink-3">{intro}</p>}
          </div>
          {children}
          {footer && <p className="m-0 text-[12.5px] text-ink-3">{footer}</p>}
        </div>
      </div>
    </main>
  );
}
