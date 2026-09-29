import { useEffect, useState, type ReactNode } from "react";
import { useMonitor } from "../../state/monitor";
import { Badge } from "../ui";

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="text-right leading-tight">
      <p className="font-mono text-sm font-medium tabular-nums">{now.toLocaleTimeString([], { hour12: false })}</p>
      <p className="text-xs text-muted">{now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</p>
    </div>
  );
}

/** Sticky page header: title, system connection status and clock. */
export function Topbar({ title, subtitle, extra }: { title: string; subtitle?: ReactNode; extra?: ReactNode }) {
  const { connected, streams } = useMonitor();
  const live = streams.filter((s) => s.status === "live").length;
  return (
    // phones: not sticky, and the actions wrap under the title (a 360-px header has no room for both)
    <header className="z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface/95 px-3 py-2.5 backdrop-blur sm:sticky sm:top-0 sm:h-16 sm:flex-nowrap sm:px-6 sm:py-0 print:static print:border-0">
      <div className="min-w-0 flex-1 max-sm:basis-full">
        <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
      </div>
      {extra}
      <div className="hidden items-center gap-2 md:flex">
        {connected ? (
          <Badge tone={live ? "success" : "warning"} dot pulse={!!live}>
            System online · {live}/{streams.length} live
          </Badge>
        ) : (
          <Badge tone="danger" dot pulse>Backend offline, reconnecting</Badge>
        )}
      </div>
      <div className="hidden md:block"><Clock /></div>
    </header>
  );
}
