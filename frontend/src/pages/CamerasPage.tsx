import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CameraDrawer, type CameraTab } from "../components/cameras/CameraDrawer";
import { sourceSummary } from "../components/cameras/SourceForm";
import { streamStatus } from "../components/cameras/status";
import { Page } from "../components/layout/Shell";
import { errorMessage, isConflict, toastSaved, useUnsavedGuard } from "../components/settings/shared";
import { Button, Empty, Icon, Notice, Panel, Segmented, Skeleton, StatusDot, Switch, Tag, useToast } from "../components/ui";
import { api, type SaveResult } from "../lib/api";
import { isChecked } from "../lib/capabilities";
import { clone } from "../lib/configForm";
import { ppeLabel } from "../lib/format";
import { hashParams } from "../lib/router";
import { useAuth } from "../state/auth";
import { useMonitor } from "../state/monitor";
import type { ConfigDoc, ConfigSchema, RawConfig, Zone } from "../types";

const MAX_CAMERAS = 64;
const SOURCE_TYPE: Record<string, string> = { rtsp: "RTSP", http: "HTTP", file: "File", images: "Images", webcam: "Webcam", onvif: "ONVIF" };
const PRIORITY: Record<string, string> = { high: "High", normal: "Normal", low: "Low" };

/** `open`: a camera id, or null for a new camera. */
type Editing = { id: string | null; tab?: CameraTab; key: number };

export function CamerasPage() {
  const toast = useToast();
  const { can } = useAuth();
  const { streams: liveStreams } = useMonitor();
  const canCameras = can("config:cameras");
  const canSystem = can("config:system");

  const [doc, setDoc] = useState<ConfigDoc | null>(null);
  const [schema, setSchema] = useState<ConfigSchema | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [drawerDirty, setDrawerDirty] = useState(false);
  const nextKey = useRef(1);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"all" | "attention" | "off">("all");
  useUnsavedGuard(drawerDirty, "This camera has unsaved changes. Leave and discard them?");

  const load = useCallback(() => {
    setLoadError(null);
    setStale(false);
    Promise.all([api.config.get(), api.config.schema()])
      .then(([d, s]) => { setDoc(d); setSchema(s); })
      .catch((e) => setLoadError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const open = useCallback((id: string | null, tab?: CameraTab) => setEditing({ id, tab, key: nextKey.current++ }), []);
  const close = useCallback(() => setEditing(null), []);

  // deep link from other pages: #/cameras?camera=gate-1&tab=zones, #/cameras?add=1
  const linked = useRef(false);
  useEffect(() => {
    if (!doc || linked.current) return;
    linked.current = true;
    const p = hashParams();
    const id = p.get("camera");
    const tab = p.get("tab");
    if (id && (doc.config.streams ?? []).some((s: RawConfig) => s.id === id)) open(id, tab === "zones" || tab === "source" || tab === "rules" ? tab : undefined);
    else if (p.get("add") && canSystem) open(null);
  }, [doc, open, canSystem]);

  const onSaved = useCallback((r: SaveResult) => {
    setDoc(r);
    setStale(false);
    api.config.schema().then(setSchema).catch(() => {}); // what the model checks may have changed
  }, []);
  const reload = useCallback(async () => {
    setDoc(await api.config.get());
    setStale(false);
  }, []);

  const cameras: RawConfig[] = useMemo(() => doc?.config.streams ?? [], [doc]);
  const live = useMemo(() => new Map(liveStreams.map((s) => [s.id, s])), [liveStreams]);

  const toggle = async (id: string, enabled: boolean) => {
    if (!doc) return;
    const next = clone(doc.config);
    const cam = (next.streams ?? []).find((s: RawConfig) => s.id === id);
    if (!cam) return;
    cam.enabled = enabled;
    setToggling(id);
    try {
      const r = await api.config.save({ config: next, etag: doc.etag });
      onSaved(r);
      toastSaved(toast, r, `${cam.name ?? id} ${enabled ? "enabled" : "disabled"}`);
    } catch (e) {
      if (isConflict(e)) setStale(true);
      else toast({ tone: "error", title: `${cam.name ?? id} could not be ${enabled ? "enabled" : "disabled"}`, message: errorMessage(e) });
    } finally {
      setToggling(null);
    }
  };

  const full = cameras.length >= MAX_CAMERAS;
  const addButton = (
    <Button variant="accent" icon="plus" disabled={!canSystem || !doc || !schema || full} onClick={() => open(null)}
      title={!canSystem ? "Adding a camera needs a Super Admin" : full ? `The limit is ${MAX_CAMERAS} cameras` : undefined}>
      Add camera
    </Button>
  );

  return (
    <Page title="Cameras & zones" actions={addButton}
      description="Each camera's video source, the PPE it requires, and the areas of its picture where the rules apply. Select a camera to edit it.">
      <div className="flex flex-col gap-4">
        {doc && !canCameras && <Notice tone="warn">Your role can look at cameras but not change them.</Notice>}
        {doc && canCameras && !canSystem && <Notice>Your role can edit each camera's rules, source and zones. Adding or removing a camera needs a Super Admin.</Notice>}
        {stale && (
          <Notice tone="bad" title="Someone else saved the configuration" action={<Button size="sm" icon="refresh" onClick={load}>Reload cameras</Button>}>
            Nothing was changed. Reload to see their version, then try again.
          </Notice>
        )}

        {loadError ? (
          <Notice tone="bad" title="The cameras could not be loaded" action={<Button size="sm" onClick={load}>Retry</Button>}>{loadError}</Notice>
        ) : !doc || !schema ? (
          <Panel className="flex flex-col gap-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</Panel>
        ) : cameras.length === 0 ? (
          <Panel>
            <Empty icon="camera" title="No cameras yet" action={canSystem ? <Button variant="primary" icon="plus" onClick={() => open(null)}>Add camera</Button> : undefined}>
              {canSystem
                ? "Add the first one: an IP camera, a webcam on the server, or a recorded video to try the system out."
                : "A Super Admin has to add the first camera."}
            </Empty>
          </Panel>
        ) : (
          <Panel className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-[18px] py-3.5">
              <label className="flex h-10 w-full items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 text-ink-3 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent-soft sm:w-72">
                <Icon name="search" size={16} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a camera, id or address" aria-label="Find a camera"
                  className="w-full min-w-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-4" />
              </label>
              <Segmented label="Show" value={show} onChange={setShow} options={[
                { value: "all", label: "All", count: cameras.length },
                { value: "attention", label: "Needs attention", count: cameras.filter((c) => { const s = live.get(String(c.id)); return c.enabled !== false && (!s || s.status !== "live" || s.violations > 0); }).length },
                { value: "off", label: "Turned off", count: cameras.filter((c) => c.enabled === false).length },
              ]} />
            </div>
            <div className="overflow-x-auto">
              <table className="table min-w-[860px]">
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Camera</th>
                    <th scope="col">Source</th>
                    <th scope="col">Required PPE</th>
                    <th scope="col" className="text-right!">Zones</th>
                    <th scope="col">Priority</th>
                    <th scope="col" className="text-right!">Rate</th>
                    <th scope="col">Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {cameras.filter((c) => {
                    const id = String(c.id), s = live.get(id), enabled = c.enabled !== false;
                    const term = q.trim().toLowerCase();
                    if (term && !`${c.name ?? ""} ${id} ${sourceSummary(c.source)}`.toLowerCase().includes(term)) return false;
                    if (show === "off") return !enabled;
                    if (show === "attention") return enabled && (!s || s.status !== "live" || s.violations > 0);
                    return true;
                  }).map((c) => {
                    const id = String(c.id);
                    const s = live.get(id);
                    const enabled = c.enabled !== false;
                    const st = streamStatus(s, enabled);
                    const ppe: string[] = c.required_ppe ?? [];
                    const zones: Zone[] = c.zones ?? [];
                    const restricted = zones.filter((z) => z.type === "restricted").length;
                    return (
                      <tr key={id} className="cursor-pointer" onClick={() => open(id)}>
                        <td className="whitespace-nowrap">
                          <span className="flex items-center gap-2" title={s?.message || undefined}>
                            <StatusDot tone={st.tone} pulse={st.tone === "ok"} />{st.label}
                          </span>
                        </td>
                        <td>
                          <button type="button" className="block max-w-56 truncate text-left font-medium text-ink hover:text-accent-strong hover:underline"
                            aria-label={`Edit ${c.name ?? id}`} onClick={(e) => { e.stopPropagation(); open(id); }}>
                            {c.name ?? id}
                          </button>
                          <span className="num text-xs text-ink-3">{id}</span>
                        </td>
                        <td>
                          <span className="flex items-center gap-2">
                            <Tag>{SOURCE_TYPE[c.source?.type] ?? c.source?.type ?? "File"}</Tag>
                            <span className="num block max-w-52 truncate text-xs text-ink-2" title={sourceSummary(c.source)}>{sourceSummary(c.source)}</span>
                          </span>
                        </td>
                        <td>
                          <span className="flex max-w-64 flex-wrap gap-1">
                            {ppe.length === 0 && !c.detect_phone && <span className="text-xs text-ink-3">None</span>}
                            {ppe.map((p) => isChecked(p, schema.capabilities)
                              ? <Tag key={p}>{ppeLabel(p)}</Tag>
                              : <Tag key={p} tone="warn" icon="eyeOff" title="Required, but not detected by the loaded model, so not enforced">{ppeLabel(p)}</Tag>)}
                            {c.detect_phone && <Tag icon="phone">Phone use</Tag>}
                          </span>
                        </td>
                        <td className="text-right whitespace-nowrap">
                          {zones.length === 0 ? <span className="text-xs text-ink-3">Whole frame</span> : (
                            <span className="num" title={restricted ? `${restricted} restricted` : undefined}>{zones.length}</span>
                          )}
                        </td>
                        <td>{PRIORITY[c.priority ?? "normal"] ?? c.priority}</td>
                        <td className="num text-right whitespace-nowrap">{s?.running && s.status === "live" ? `${s.fps.toFixed(1)} fps` : <span className="text-ink-3">–</span>}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <Switch checked={enabled} disabled={!canCameras || toggling !== null || stale} onChange={(v) => void toggle(id, v)}
                            label={<span className="sr-only">{c.name ?? id} enabled</span>} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="border-t border-line px-4 py-2 text-xs text-ink-3">
              <span className="num">{cameras.length}</span> of <span className="num">{MAX_CAMERAS}</span> cameras.
              Turning a camera off stops it straight away and keeps its settings and history.
            </p>
          </Panel>
        )}
      </div>

      {editing && doc && schema && (
        <CameraDrawer key={editing.key} doc={doc} schema={schema} cameraId={editing.id} initialTab={editing.tab}
          stream={editing.id ? live.get(editing.id) : undefined}
          onClose={close} onSaved={onSaved} onReload={reload} onDirty={setDrawerDirty} />
      )}
    </Page>
  );
}
