/** Many cameras down at once is one problem. Say so once, with the likely cause, instead of leaving 30 identical tiles to explain themselves. */
import { systemicOutage } from "../cameras/status";
import { Button, Notice } from "../ui";
import { navigate } from "../../lib/router";
import type { StreamInfo } from "../../types";
import { useAuth } from "../../state/auth";

export function OutageBanner({ streams, className }: { streams: StreamInfo[]; className?: string }) {
  const { can } = useAuth();
  const outage = systemicOutage(streams);
  if (!outage) return null;
  return (
    <Notice tone="bad" title={outage.headline} className={className}
      action={can("monitor:view") ? <Button size="sm" onClick={() => navigate("system")}>Open System health</Button> : undefined}>
      <p>{outage.detail}</p>
      {outage.all && <p className="mt-1 text-xs text-ink-3">While they are down, nobody is being monitored. Ask the area supervisors to check by eye.</p>}
    </Notice>
  );
}
