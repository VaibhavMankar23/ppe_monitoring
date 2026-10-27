import type { ReactNode } from "react";
import { Icon, type IconName } from "../ui";

const POINTS: [IconName, string, string][] = [
  ["monitoring", "Live, on every camera", "Workers are checked continuously; unsafe moments surface in seconds."],
  ["incidents", "Evidence you can trust", "Confirmed across several frames, with the clearest frame kept."],
  ["reports", "Better every week", "Every verdict sharpens the model and the compliance figures."],
];

/**
 * Frame for the screens outside the app (sign in, forced password change): an obsidian brand
 * panel with an iris glow on the left (hidden on narrow screens), the form on the right.
 */
export function AuthFrame({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main id="main" className="grid min-h-dvh bg-canvas p-0 min-[1000px]:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] min-[1000px]:p-3">
      <div className="relative hidden flex-col overflow-hidden rounded-[24px] bg-[#07070a] p-12 text-[#c9c9d4] min-[1000px]:flex">
        <div aria-hidden="true" className="absolute -top-40 -right-32 size-[520px] rounded-full bg-[#6d5bf6] opacity-40 blur-[120px]" />
        <div aria-hidden="true" className="absolute -bottom-48 -left-24 size-[420px] rounded-full bg-[#2fb8ff] opacity-[0.18] blur-[120px]" />
        <div aria-hidden="true" className="absolute inset-0 opacity-[0.06] [background-image:radial-gradient(rgba(255,255,255,.9)_1px,transparent_1px)] [background-size:22px_22px]" />
        <div className="relative flex items-center gap-2.5">
          <img src="/mahindra-logo-on-dark.png" alt="Mahindra" className="h-[26px] w-auto" />
          <span aria-hidden="true" className="h-5 w-px bg-white/15" />
          <span className="text-[15px] font-bold tracking-tight text-white">PPE<span className="font-medium text-white/60"> Compliance</span></span>
        </div>
        <div className="relative mt-auto">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[12px] font-bold tracking-[0.1em] text-[#b9afff] uppercase backdrop-blur">
            <span className="size-1.5 rounded-full bg-[#34d399]" />Safety intelligence
          </div>
          <h2 className="max-w-[14ch] text-[46px] leading-[1.02] font-extrabold tracking-[-0.04em] text-white">Every worker home safe, every shift.</h2>
          <div className="mt-10 grid gap-3">
            {POINTS.map(([icon, t, d]) => (
              <div key={t} className="flex items-start gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-4 backdrop-blur">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#8b7cff]/20 text-[#c3baff]"><Icon name={icon} size={19} /></span>
                <div><b className="block text-[14.5px] font-bold text-white">{t}</b><span className="text-[13.5px] text-white/60">{d}</span></div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="grid place-items-center px-6 py-10">
        <div className="grid w-full max-w-[400px] gap-5">
          <img src="/mahindra-logo.png" alt="Mahindra" className="block h-[28px] w-auto justify-self-start dark:hidden" />
          <img src="/mahindra-logo-on-dark.png" alt="" className="hidden h-[28px] w-auto justify-self-start dark:block" />
          <div>
            <h1 className="text-[32px] leading-tight font-extrabold tracking-[-0.035em]">{title}</h1>
            {intro && <p className="mt-2 text-[14.5px] text-ink-3">{intro}</p>}
          </div>
          {children}
          {footer && <p className="m-0 text-[12.5px] text-ink-4">{footer}</p>}
        </div>
      </div>
    </main>
  );
}
