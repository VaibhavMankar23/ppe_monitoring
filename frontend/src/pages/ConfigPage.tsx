import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackupsModal } from "../components/config/BackupsModal";
import { ConfigFormContext, FieldGrid, NumberField, SelectField, TextField, ToggleField, type FormCtx } from "../components/config/fields";
import { StreamsSection } from "../components/config/StreamsSection";
import { YamlEditor } from "../components/config/YamlEditor";
import { PageBody } from "../components/layout/PageBody";
import { Topbar } from "../components/layout/Topbar";
import { Advisory, Badge, Button, Card, CardHeader, ConfirmModal, EmptyState, Icon, Skeleton, useToast } from "../components/ui";
import { api, ApiError, type SaveResult } from "../lib/api";
import { phoneProblem } from "../lib/capabilities";
import { clone, sameJson, setIn } from "../lib/configForm";
import { setNavigationGuard } from "../lib/router";
import { useAuth } from "../state/auth";
import type { CameraChanges, ConfigDoc, ConfigSchema, FieldError, RawConfig } from "../types";

type View = "form" | "yaml";
const SECTIONS = [["general", "General"], ["model", "Model"], ["tracker", "Tracker"], ["streams", "Streams"], ["violations", "Violations"], ["alarm", "Alarm"], ["performance", "Performance"]] as const;
const YAML_HEADER = "# PPE compliance monitor configuration (converted from the form view; comments were not kept)\n\n";

const toMap = (errs: FieldError[]) => Object.fromEntries(errs.map((e) => [e.loc, e.msg]));
// what an Admin may change: these keys of an existing camera (mirrors config_diff.ADMIN_STREAM_KEYS on the server)
const ADMIN_EDITABLE = /^streams\.\d+\.(name|enabled|required_ppe|confidence|priority|source)(\.|$)/;

/** Marks a config section the current role can only read. */
function Locked({ locked }: { locked: boolean }) {
  return locked ? <Badge><Icon.lock size={12} /> Super Admin only</Badge> : null;
}

// camera edits worth a second look before saving: where it gets its video, and whether it runs at all
const SIGNIFICANT = /^(source\.|enabled$)/;
const needsConfirm = (c?: CameraChanges) => !!c && (c.removed.length > 0 || c.changed.some((x) => x.fields.some((f) => SIGNIFICANT.test(f))));

/** What a save / reset / restore does to the cameras, for the confirmation dialog. */
function CameraDiff({ changes }: { changes: CameraChanges }) {
  const significant = changes.changed.filter((c) => c.fields.some((f) => SIGNIFICANT.test(f)));
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      {changes.removed.length > 0 && (
        <div>
          <p className="font-semibold text-danger">Removed ({changes.removed.length}) — the camera stops and leaves the configuration. Its stored violations are kept.</p>
          <ul className="mt-1 list-disc pl-5 text-text">{changes.removed.map((c) => <li key={c.id}>{c.name} <span className="font-mono text-muted">{c.id}</span></li>)}</ul>
        </div>
      )}
      {significant.length > 0 && (
        <div>
          <p className="font-semibold text-text">Changed</p>
          <ul className="mt-1 list-disc pl-5 text-text">{significant.map((c) => (
            <li key={c.id}>{c.name} <span className="font-mono text-muted">{c.id}</span>: <span className="font-mono">{c.fields.join(", ")}</span></li>
          ))}</ul>
        </div>
      )}
      {changes.added.length > 0 && <p className="text-text">Added: {changes.added.map((c) => c.name).join(", ")}</p>}
    </div>
  );
}

function summarize(r: SaveResult["reload"]): string {
  const parts: string[] = [];
  if (r.restarted.length) parts.push(`restarted ${r.restarted.join(", ")}`);
  if (r.started.length) parts.push(`started ${r.started.join(", ")}`);
  if (r.stopped.length) parts.push(`stopped ${r.stopped.join(", ")}`);
  if (r.added.length) parts.push(`added ${r.added.join(", ")}`);
  if (r.removed.length) parts.push(`removed ${r.removed.join(", ")}`);
  if (r.engine_reloaded) parts.push("model engine reloaded");
  return parts.length ? `Applied live: ${parts.join(" · ")}.` : "No running cameras needed a restart.";
}

export function ConfigPage() {
  const toast = useToast();
  const { can } = useAuth();
  const system = can("config:system");
  const canEdit = useCallback((path: string) => system || ADMIN_EDITABLE.test(path), [system]);
  const [doc, setDoc] = useState<ConfigDoc | null>(null);
  const [schema, setSchema] = useState<ConfigSchema | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RawConfig>({});
  const [yamlDraft, setYamlDraft] = useState("");
  const [view, setView] = useState<View>("form");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetAll, setResetAll] = useState(false); // factory reset incl. cameras (off: cameras are kept)
  // a camera-changing write waiting for the user's confirmation
  const [pending, setPending] = useState<{ what: string; done: string; changes: CameraChanges; run: (confirm?: string[]) => Promise<SaveResult> } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const adopt = useCallback((d: ConfigDoc) => {
    setDoc(d);
    setDraft(clone(d.config));
    setYamlDraft(d.yaml);
    setErrors([]);
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([api.config.get(), api.config.schema()])
      .then(([d, s]) => { adopt(d); setSchema(s); })
      .catch((e) => setLoadError((e as Error).message));
  }, [adopt]);
  useEffect(load, [load]);

  const dirty = !!doc && (view === "form" ? !sameJson(draft, doc.config) : yamlDraft !== doc.yaml);

  // warn before leaving with unsaved changes (tab close and in-app navigation)
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => { if (dirtyRef.current) e.preventDefault(); };
    window.addEventListener("beforeunload", onUnload);
    setNavigationGuard(() => !dirtyRef.current || window.confirm("You have unsaved config changes. Leave and discard them?"));
    return () => { window.removeEventListener("beforeunload", onUnload); setNavigationGuard(null); };
  }, []);

  // live validation (debounced) so errors show while typing
  useEffect(() => {
    if (!doc || !dirty) { setErrors([]); return; }
    const t = window.setTimeout(() => {
      api.config.validate(view === "form" ? { config: draft } : { yaml: yamlDraft })
        .then((r) => setErrors(r.errors)).catch(() => {});
    }, 500);
    return () => window.clearTimeout(t);
  }, [draft, yamlDraft, view, doc, dirty]);

  const errMap = useMemo(() => toMap(errors), [errors]);
  const set = useCallback((path: string, value: unknown) => setDraft((d) => setIn(d, path, value)), []);
  const ctx: FormCtx = { draft, set, errors: errMap, schema, canEdit, saved: doc?.config };
  const savedIds = useMemo(() => new Set<string>((doc?.config.streams ?? []).map((s: { id: string }) => s.id)), [doc]);

  const afterSave = (r: SaveResult, what: string) => {
    adopt(r);
    toast({ tone: "success", title: what, message: summarize(r.reload) });
    if (r.reload.requires_server_restart.length) {
      toast({ tone: "warning", title: "Restart the server to apply", message: `${r.reload.requires_server_restart.join(", ")} only take effect after a restart.` });
    }
  };
  const onError = (e: unknown, what: string) => {
    if (e instanceof ApiError && e.status === 422) {
      setErrors(e.fields);
      toast({ tone: "error", title: `${what}: ${e.fields.length} field${e.fields.length === 1 ? "" : "s"} need attention`, message: "Invalid fields are highlighted." });
      requestAnimationFrame(() => document.querySelector("[aria-invalid='true'],[role='alert']")?.scrollIntoView({ behavior: "smooth", block: "center" }));
    } else if (e instanceof ApiError && e.status === 409) {
      toast({ tone: "error", title: "Config changed elsewhere", message: "Someone saved config.yaml after you opened it. Discard your changes to reload the latest version." });
    } else {
      toast({ tone: "error", title: `${what} failed`, message: (e as Error).message });
    }
  };

  /** Run a config write; if the server says it would remove cameras, ask first (then re-run with them confirmed). */
  const runGuarded = async (what: string, done: string, run: (confirm?: string[]) => Promise<SaveResult>, confirm?: string[]) => {
    try {
      afterSave(await run(confirm), done);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "confirm_camera_removal") {
        setPending({ what, done, changes: (e.data as { cameras: CameraChanges }).cameras, run });
      } else onError(e, what);
      return false;
    }
  };

  const save = async () => {
    if (!doc) return;
    setSaving(true);
    try {
      const body = view === "form" ? { config: draft, etag: doc.etag } : { yaml: yamlDraft, etag: doc.etag };
      const run = (confirm?: string[]) => api.config.save({ ...body, confirm_remove: confirm });
      const check = await api.config.validate(body); // preview: what this does to the cameras
      if (check.valid && needsConfirm(check.cameras)) {
        setPending({ what: "Save", done: "Configuration saved", changes: check.cameras!, run });
        return;
      }
      await runGuarded("Save", "Configuration saved", run);
    } catch (e) { onError(e, "Save"); } finally { setSaving(false); }
  };

  const confirmPending = async () => {
    if (!pending) return;
    const p = pending;
    setPending(null);
    setSaving(true);
    try { await runGuarded(p.what, p.done, p.run, p.changes.removed.map((c) => c.id)); } finally { setSaving(false); }
  };

  const reset = async () => {
    setSaving(true);
    setConfirmReset(false);
    try {
      await runGuarded("Reset", resetAll ? "Factory defaults restored" : "Settings reset to defaults (cameras kept)",
        (confirm) => api.config.reset({ keep_cameras: !resetAll, confirm_remove: confirm }));
    } finally { setSaving(false); setResetAll(false); }
  };

  const restore = async (name: string) => {
    setRestoring(name);
    try {
      await runGuarded("Restore", "Backup restored", (confirm) => api.config.restore(name, confirm));
      setBackupsOpen(false);
    } finally { setRestoring(null); }
  };

  const discard = () => {
    setConfirmDiscard(false);
    load(); // also picks up changes made elsewhere
    toast({ tone: "info", title: "Changes discarded" });
  };

  const switchView = (v: View) => {
    if (v === view || !doc) return;
    if (v === "yaml") {
      // keep the file's comments when the form wasn't touched
      setYamlDraft(sameJson(draft, doc.config) ? doc.yaml : YAML_HEADER + yamlDump(draft, { lineWidth: 120, noRefs: true }));
    } else {
      try {
        const parsed = yamlLoad(yamlDraft);
        if (!parsed || typeof parsed !== "object") throw new Error("the document must be a mapping");
        setDraft(parsed as RawConfig);
      } catch (e) {
        toast({ tone: "error", title: "Fix the YAML before switching", message: (e as Error).message.split("\n")[0] });
        return;
      }
    }
    setView(v);
  };

  const yamlErrorLines = errors.filter((e) => e.line).map((e) => e.line!) as number[];

  return (
    <>
      <Topbar title="Config" subtitle={doc ? <span className="font-mono">{doc.path}</span> : "Loading…"}
        extra={dirty ? <Badge tone="warning" dot>Unsaved changes</Badge> : doc ? <Badge tone="success" dot>Saved</Badge> : null} />
      <PageBody>
        {loadError ? (
          <Card><EmptyState icon={<Icon.alert size={20} />} title="Couldn't load the configuration" message={loadError} action={<Button onClick={load}>Try again</Button>} /></Card>
        ) : !doc ? (
          <div className="flex flex-col gap-6">{[0, 1, 2].map((i) => <Card key={i} className="p-5"><Skeleton className="mb-4 h-5 w-40" /><div className="grid grid-cols-3 gap-4"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div></Card>)}</div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* toolbar */}
            <Card className="z-10 flex flex-wrap items-center gap-2 px-4 py-3 md:sticky md:top-[76px]">
              {system ? <div className="inline-flex rounded-lg border border-border bg-subtle p-0.5" role="group" aria-label="Editor view">
                {(["form", "yaml"] as View[]).map((v) => (
                  <button key={v} type="button" aria-pressed={view === v} onClick={() => switchView(v)}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium ${view === v ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"}`}>
                    {v === "form" ? <><Icon.form size={14} /> Form view</> : <><Icon.code size={14} /> Raw YAML view</>}
                  </button>
                ))}
              </div> : <Badge tone="primary"><Icon.info size={12} /> Admin: you can edit camera name, source, enabled, required PPE and confidence</Badge>}
              {view === "form" && (
                <nav className="hidden flex-wrap gap-1 lg:flex" aria-label="Jump to section">
                  {SECTIONS.map(([id, label]) => <a key={id} href={`#/config`} onClick={(e) => { e.preventDefault(); document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                    className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-subtle hover:text-text">{label}</a>)}
                </nav>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {system && <Button variant="ghost" icon={<Icon.history size={15} />} onClick={() => setBackupsOpen(true)}>Restore from backup</Button>}
                {system && <Button variant="danger-ghost" icon={<Icon.undo size={15} />} onClick={() => setConfirmReset(true)}>Reset to defaults</Button>}
                <Button disabled={!dirty || saving} onClick={() => setConfirmDiscard(true)}>Discard changes</Button>
                <Button variant="primary" icon={<Icon.save size={15} />} disabled={!dirty} loading={saving} onClick={save}>Save</Button>
              </div>
            </Card>

            {errors.length > 0 && (
              <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger" role="alert">
                <p className="font-semibold">{errors.length} problem{errors.length === 1 ? "" : "s"} must be fixed before saving</p>
                <ul className="mt-1 list-disc pl-5">
                  {errors.slice(0, 6).map((e, i) => <li key={i}><span className="font-mono">{e.loc}{e.line ? ` (line ${e.line})` : ""}</span>: {e.msg}</li>)}
                  {errors.length > 6 && <li>…and {errors.length - 6} more</li>}
                </ul>
              </div>
            )}

            {view === "yaml" ? (
              <Card>
                <CardHeader title="config.yaml" description="Edited as text: comments are preserved. Validated as you type; saving writes a backup first." />
                <div className="p-4"><YamlEditor id="cfg-yaml" label="config.yaml contents" value={yamlDraft} onChange={setYamlDraft} errorLines={yamlErrorLines} /></div>
              </Card>
            ) : (
              <ConfigFormContext.Provider value={ctx}>
                <Card id="sec-general">
                  <CardHeader title="General" description="Server and the rules that decide compliance." actions={<Locked locked={!system} />} />
                  <div className="p-5"><FieldGrid>
                    <TextField path="server.host" label="Server host" hint="Needs a server restart" />
                    <NumberField path="server.port" label="Server port" hint="Needs a server restart" step={1} />
                    <SelectField path="compliance.missing_policy" label="Missing-PPE policy" options={[
                      { value: "strict", label: "Strict: not seen counts as missing" },
                      { value: "negative_only", label: "Negative only: needs an explicit “no-X”" }]} />
                    <NumberField path="compliance.min_containment" label="Min. containment" step={0.05} hint="Share of a PPE box inside the body zone (0–1)" />
                    <NumberField path="compliance.min_person_height" label="Min. person height" unit="px" step={1} hint="Smaller people are shown as uncertain" />
                    <NumberField path="compliance.smoothing_window" label="Smoothing window" unit="frames" step={1} hint="Majority vote to stop flicker" />
                  </FieldGrid></div>
                </Card>

                <Card id="sec-model">
                  <CardHeader title="Model" description="Detector weights and inference settings. Changes reload the engine; cameras keep running." actions={<Locked locked={!system} />} />
                  <div className="p-5"><FieldGrid>
                    <TextField path="model.weights" label="Weights path" hint="Relative to config.yaml; ${PPE_MODEL_WEIGHTS} allowed" className="md:col-span-2" />
                    <div className="flex flex-col gap-1.5 md:col-span-2">
                      <TextField path="model.phone_weights" label="Phone model (optional)"
                        hint="An additional detector (e.g. ../models/coco/yolov8n.pt) run next to the PPE model, only while at least one camera has “Detect phone use” on — it adds inference work on those cameras. Blank = phone use is not checked anywhere." />
                      {(draft.streams ?? []).some((st: { detect_phone?: boolean }) => st.detect_phone)
                        && phoneProblem(draft.model?.phone_weights, schema?.capabilities, doc?.config.model?.phone_weights)?.startsWith("No phone model") && (
                        <Advisory title="Phone use is not checked.">
                          {(draft.streams as { detect_phone?: boolean; name?: string }[]).filter((st) => st.detect_phone).map((st) => st.name).join(", ")} ha{(draft.streams as { detect_phone?: boolean }[]).filter((st) => st.detect_phone).length === 1 ? "s" : "ve"} “Detect phone use” on, but no phone model is configured. Set one (e.g. ../models/coco/yolov8n.pt) above — the camera toggle alone isn't enough.
                        </Advisory>
                      )}
                      {schema?.capabilities?.phone.load_failed && draft.model?.phone_weights === doc?.config.model?.phone_weights && (
                        <Advisory title="Phone use is not checked.">The configured phone model couldn't be loaded (missing file, or no phone class). Check the server log.</Advisory>
                      )}
                    </div>
                    <SelectField path="model.device" label="Device" options={(schema?.devices ?? ["auto"]).map((d) => ({ value: d, label: d === "auto" ? "auto (CUDA › Intel GPU › CPU)" : d }))} />
                    <NumberField path="model.default_confidence" label="Default confidence" step={0.05} hint="Starting value of each tile's slider" />
                    <NumberField path="model.iou" label="NMS IoU threshold" step={0.05} hint="Overlap above which duplicate boxes merge" />
                    <SelectField path="model.imgsz" numeric label="Image size (GPU)" options={[320, 416, 480, 512, 640, 768, 960, 1280].map((n) => ({ value: String(n), label: `${n} px` }))} />
                    <SelectField path="model.cpu_imgsz" numeric label="Image size (CPU only)" options={[320, 416, 480, 512, 640].map((n) => ({ value: String(n), label: `${n} px` }))} />
                    <ToggleField path="model.openvino" label="Use OpenVINO" hint="Intel CPU / iGPU acceleration when no NVIDIA GPU" />
                  </FieldGrid></div>
                </Card>

                <Card id="sec-tracker">
                  <CardHeader title="Tracker" description="How people keep their ID from frame to frame." actions={<Locked locked={!system} />} />
                  <div className="p-5"><FieldGrid cols={4}>
                    <NumberField path="tracking.low_thresh" label="Low confidence" step={0.05} hint="Weakest detection that continues a track" />
                    <NumberField path="tracking.match_iou" label="Match IoU" step={0.05} hint="Overlap needed to link a detection" />
                    <NumberField path="tracking.max_lost_seconds" label="Keep lost tracks" unit="s" step={0.5} />
                    <NumberField path="tracking.min_hits" label="Confirm after" unit="frames" step={1} />
                  </FieldGrid></div>
                </Card>

                <StreamsSection savedIds={savedIds} onAddRequest={() => { location.hash = "#/add-camera"; }} />

                <Card id="sec-violations">
                  <CardHeader title="Violations" description="When an alert is raised and how long records are kept." actions={<Locked locked={!system} />} />
                  <div className="p-5"><FieldGrid cols={4}>
                    <NumberField path="alerts.min_violation_frames" label="Confirm after" unit="frames" step={1} hint="Consecutive non-compliant frames before a violation is confirmed" />
                    <NumberField path="alerts.min_violation_seconds" label="…and lasting at least" unit="s" step={0.5} hint="So a single unreliable frame never becomes a violation" />
                    <NumberField path="alerts.event_gap_seconds" label="Event ends after" unit="s" step={1} hint="A violation stays one event (extended, not duplicated) until the worker is compliant or gone this long" />
                    <NumberField path="alerts.cooldown_seconds" label="New violation after" unit="s" step={1} hint="Same worker: a new violation needs the previous event to have ended and this long since it began" />
                    <NumberField path="alerts.snapshot_quality" label="Snapshot quality" unit="JPEG 30–100" step={5} />
                    <ToggleField path="alerts.save_original_frame" label="Keep the original frame" hint="Store the clean full-resolution frame next to the annotated evidence image" />
                    <NumberField path="alerts.retention_days" label="Retention" unit="days" step={1} hint="Older records are deleted hourly; 0 = keep forever" />
                    <NumberField path="alerts.evidence_retention_days" label="Evidence image retention" unit="days" step={1} hint="Images of older (ended) violations are removed; the record and thumbnail stay until Retention. 0 = keep with the record" />
                    <SelectField path="alerts.evidence_imgsz" numeric label="Evidence box re-detection" options={[{ value: "0", label: "Off (use the tracked box)" }, { value: "480", label: "480 px" }, { value: "640", label: "640 px (recommended)" }, { value: "800", label: "800 px" }]}
                      hint="Re-detects the worker on the full-resolution alert frame so the snapshot box is exact" />
                    <ToggleField path="alerts.require_confident_box" label="Wait for a confident box" hint="Don't fire an alert on a frame where the worker's box is a low-confidence guess" />
                    <ToggleField path="alerts.drop_unconfirmed" label="Drop phantom alerts" hint="Skip alerts when the full-resolution check finds no person there" />
                    <NumberField path="analytics.compliance_target" label="Compliance target" step={0.01} hint="Goal line on the Analytics compliance trend (0.95 = 95 %)" />
                  </FieldGrid></div>
                </Card>

                <Card id="sec-alarm">
                  <CardHeader title="Alarm" description="Trigger an outbound alarm on each stored violation. Rate-limited per camera, on top of the dedupe above. Put secrets in env vars, e.g. password: ${PPE_SMTP_PASSWORD}." actions={<Locked locked={!system} />} />
                  <div className="p-5 space-y-5">
                    <FieldGrid cols={4}>
                      <NumberField path="alarm.cooldown_seconds" label="Per-camera cooldown" unit="s" step={1} hint="Minimum gap between alarms for one camera" />
                    </FieldGrid>
                    <div>
                      <p className="mb-3 text-[13px] font-semibold">Webhook (HTTP POST)</p>
                      <FieldGrid cols={4}>
                        <ToggleField path="alarm.webhook.enabled" label="Enable webhook" hint="POST violation JSON to a hooter/relay gateway, Teams/Slack, a PLC, …" />
                        <TextField path="alarm.webhook.url" label="Webhook URL" className="md:col-span-2" />
                        <NumberField path="alarm.webhook.timeout" label="Timeout" unit="s" step={1} />
                      </FieldGrid>
                    </div>
                    <div>
                      <p className="mb-3 text-[13px] font-semibold">Email (SMTP)</p>
                      <FieldGrid cols={4}>
                        <ToggleField path="alarm.email.enabled" label="Enable email" />
                        <TextField path="alarm.email.smtp_host" label="SMTP host" />
                        <NumberField path="alarm.email.smtp_port" label="SMTP port" step={1} />
                        <ToggleField path="alarm.email.use_tls" label="Use STARTTLS" hint="On for port 587" />
                        <TextField path="alarm.email.username" label="Username" />
                        <TextField path="alarm.email.password" label="Password" hint="Use ${PPE_SMTP_PASSWORD} and set the env var to keep it out of the file" className="md:col-span-2" />
                        <TextField path="alarm.email.sender" label="From address" />
                        <TextField path="alarm.email.recipients" label="Recipients" hint="Comma-separated" className="md:col-span-2" />
                        <ToggleField path="alarm.email.attach_snapshot" label="Attach snapshot" />
                      </FieldGrid>
                    </div>
                  </div>
                </Card>

                <Card id="sec-performance">
                  <CardHeader title="Performance" description="Trade accuracy for speed. The video stays live either way: stale frames are dropped." actions={<Locked locked={!system} />} />
                  <div className="p-5"><FieldGrid cols={4}>
                    <NumberField path="inference.frame_skip" label="Frame skip" unit="frames" step={1} hint="Extra frames skipped between processed ones" />
                    <NumberField path="inference.process_width" label="Downscale width" unit="px" step={32} hint="Frames are resized to this width" />
                    <NumberField path="inference.max_fps_per_stream" label="Max FPS per camera" step={1} />
                    <NumberField path="inference.jpeg_quality" label="Video JPEG quality" step={5} />
                    <SelectField path="inference.mode" label="Engine mode" options={[{ value: "batched", label: "Batched (one engine)" }, { value: "per_stream", label: "Per camera (isolated)" }]} />
                    <ToggleField path="inference.person_refine" label="Person close-up pass" hint="Re-detect PPE on full-resolution person crops" />
                    <SelectField path="inference.refine_imgsz" numeric label="Close-up size" options={[224, 256, 288, 320, 384, 416].map((n) => ({ value: String(n), label: `${n} px` }))} />
                    <NumberField path="inference.refine_batch" label="Close-ups per call" step={1} />
                    <NumberField path="inference.max_batch" label="Cameras per model call" step={1} hint="Ready cameras beyond this wait for the next call" />
                    <NumberField path="inference.post_workers" label="Post-processing workers" step={1} hint="0 = auto (half the CPU cores). Needs a restart" />
                    <ToggleField path="inference.focus_pause_others" label="Focus mode pauses others" hint="While someone watches one camera full screen, pause detection (not video) on the rest. Off = always all live" />
                    <NumberField path="inference.paused_preview_fps" label="Paused camera video" unit="fps" step={1} />
                  </FieldGrid></div>
                </Card>
              </ConfigFormContext.Provider>
            )}
          </div>
        )}
      </PageBody>

      <ConfirmModal open={confirmReset} danger busy={saving} title="Reset settings to defaults?" confirmLabel={resetAll ? "Continue" : "Reset settings"}
        message={<div className="flex flex-col gap-3">
          <p>Every setting (model, tracker, compliance, violations, alarm, performance) is reset to <span className="font-mono">config.default.yaml</span>. A backup of the current file is kept, so you can restore it.</p>
          <p className="font-medium text-text">Your {(doc?.config.streams ?? []).length} camera{(doc?.config.streams ?? []).length === 1 ? " is" : "s are"} kept unchanged.</p>
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-danger)]" checked={resetAll} onChange={(e) => setResetAll(e.target.checked)} />
            <span>Also remove all cameras (full factory reset). You'll be asked to confirm the cameras being removed.</span>
          </label>
        </div>}
        onConfirm={reset} onCancel={() => { setConfirmReset(false); setResetAll(false); }} />
      <ConfirmModal open={!!pending} danger={!!pending?.changes.removed.length} busy={saving}
        title={pending?.changes.removed.length ? `${pending.what}: remove ${pending.changes.removed.length} camera${pending.changes.removed.length === 1 ? "" : "s"}?` : `${pending?.what ?? "Save"}: confirm camera changes`}
        confirmLabel={pending?.changes.removed.length ? `Remove ${pending.changes.removed.length} and ${pending.what.toLowerCase()}` : "Save changes"}
        message={pending ? <CameraDiff changes={pending.changes} /> : null}
        onConfirm={confirmPending} onCancel={() => setPending(null)} />
      <ConfirmModal open={confirmDiscard} title="Discard unsaved changes?" confirmLabel="Discard" danger
        message="Your edits are thrown away and the saved configuration is reloaded." onConfirm={discard} onCancel={() => setConfirmDiscard(false)} />
      <BackupsModal open={backupsOpen} onClose={() => setBackupsOpen(false)} onRestore={restore} busy={restoring} />
    </>
  );
}
