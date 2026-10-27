import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Page } from "../components/layout/Shell";
import { BackupsPanel, ResetPanel, YamlPanel } from "../components/settings/Advanced";
import {
  ConfigFormContext, FieldGrid, ListField, NumberField, SecretField, SelectField, TextField, ToggleField, type FormCtx,
} from "../components/settings/fields";
import {
  CameraChangeList, errorMessage, fieldErrors, isConflict, removalRequest, toastSaved, useUnsavedGuard,
} from "../components/settings/shared";
import { Button, ConfirmDialog, cx, Empty, Notice, Panel, PanelHeader, Select, Skeleton, Tag, useToast } from "../components/ui";
import { api, type SaveResult } from "../lib/api";
import { clone, getIn, sameJson, setIn } from "../lib/configForm";
import { ppeLabel } from "../lib/format";
import { href } from "../lib/router";
import { useAuth } from "../state/auth";
import type { CameraChanges, Capabilities, ConfigDoc, ConfigSchema, FieldError, RawConfig } from "../types";

type SectionId = "model" | "performance" | "tracking" | "compliance" | "alerts" | "alarm" | "server" | "advanced";
const SECTIONS: { id: SectionId; label: string; hint: string; prefixes: string[] }[] = [
  { id: "model", label: "Detection model", hint: "Which model finds workers and PPE, and how it runs. Saving reloads the model; cameras keep running.", prefixes: ["model"] },
  { id: "performance", label: "Performance", hint: "How much work each camera costs. Video stays live either way: late frames are dropped, not queued.", prefixes: ["inference"] },
  { id: "tracking", label: "Tracking", hint: "How a worker keeps the same identity from one frame to the next.", prefixes: ["tracking"] },
  { id: "compliance", label: "Compliance rules", hint: "How detections become a verdict on each worker.", prefixes: ["compliance", "analytics"] },
  { id: "alerts", label: "Alerts & retention", hint: "When a violation is recorded and how long its evidence is kept.", prefixes: ["alerts"] },
  { id: "alarm", label: "Alarms", hint: "Notify other systems or people each time a violation is recorded.", prefixes: ["alarm"] },
  { id: "server", label: "Server", hint: "How the application itself is served.", prefixes: ["server"] },
  { id: "advanced", label: "Advanced", hint: "", prefixes: [] },
];
const sectionOf = (path: string): SectionId | null => SECTIONS.find((s) => s.prefixes.includes(path.split(".")[0]))?.id ?? null;

/** Leaf paths (lists count as one value) that differ between two config objects, cameras excluded. */
function changedPaths(a: RawConfig, b: RawConfig): string[] {
  const flat = (o: unknown, prefix: string, out: Record<string, unknown>) => {
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) if (prefix || k !== "streams") flat(v, prefix ? `${prefix}.${k}` : k, out);
    } else out[prefix] = o;
    return out;
  };
  const fa = flat(a, "", {}), fb = flat(b, "", {});
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => !sameJson(fa[k] ?? null, fb[k] ?? null)).sort();
}

const px = (sizes: number[]) => sizes.map((n) => ({ value: String(n), label: `${n} px` }));

function ModelSummary({ caps }: { caps: Capabilities | undefined }) {
  const row = "flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-2 last:border-b-0";
  const key = "eyebrow w-32 shrink-0";
  if (!caps) return null;
  const phone = caps.phone;
  const phoneState: [ReactNode, string] = !phone.configured
    ? [<Tag>Not configured</Tag>, "Phone use is not checked on any camera."]
    : phone.load_failed
      ? [<Tag tone="bad">Could not be loaded</Tag>, "The file is missing or has no phone class. Check the server log."]
      : phone.loaded
        ? [<Tag tone="ok">Loaded</Tag>, `Checking ${phone.wanted_by_cameras.length} camera${phone.wanted_by_cameras.length === 1 ? "" : "s"}.`]
        : [<Tag>Configured, idle</Tag>, "It loads when a camera turns phone-use detection on."];
  return (
    <div className="rounded-md bg-sunken px-3 py-1">
      <div className={row}>
        <span className={key}>Loaded model</span>
        {caps.model?.weights
          ? <span className="num min-w-0 text-[13px] break-all">{caps.model.weights}{caps.model.sha256 && <span className="text-ink-3"> · sha256 {caps.model.sha256.slice(0, 10)}</span>}</span>
          : <span className="text-[13px] text-ink-3">No model is loaded yet.</span>}
      </div>
      <div className={row}>
        <span className={key}>Can detect</span>
        <span className="flex flex-wrap gap-1.5">
          {caps.ppe_supported === null ? <span className="text-[13px] text-ink-3">Unknown until a model is loaded.</span>
            : caps.ppe_supported.length === 0 ? <span className="text-[13px] text-ink-3">No PPE item.</span>
              : caps.ppe_supported.map((p) => <Tag key={p} tone="ok" icon="check">{ppeLabel(p)}</Tag>)}
        </span>
      </div>
      {!!caps.ppe_not_supported?.length && (
        <div className={row}>
          <span className={key}>Cannot detect</span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {caps.ppe_not_supported.map((p) => <Tag key={p} tone="warn" icon="eyeOff">{ppeLabel(p)}</Tag>)}
            <span className="text-xs text-ink-3">A camera can require these, but no violation is raised for them.</span>
          </span>
        </div>
      )}
      <div className={row}>
        <span className={key}>Phone model</span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">{phoneState[0]}<span className="text-xs text-ink-3">{phoneState[1]}</span></span>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 border-t border-line pt-4">
      <legend className="eyebrow float-left mb-3 w-full">{title}</legend>
      <div className="clear-both">{children}</div>
    </fieldset>
  );
}

function SectionFields({ id, schema, draft }: { id: Exclude<SectionId, "advanced">; schema: ConfigSchema; draft: RawConfig }) {
  switch (id) {
    case "model":
      return (
        <>
          <ModelSummary caps={schema.capabilities} />
          <FieldGrid>
            <TextField path="model.weights" label="PPE model weights" mono className="sm:col-span-2"
              hint="Path to the detector file, relative to the configuration file. It decides which PPE items can be checked at all." />
            <TextField path="model.phone_weights" label="Phone model weights" mono className="sm:col-span-2" placeholder="../models/coco/yolov8n.pt"
              hint="A second detector, run only for cameras with phone-use detection on. Empty turns phone detection off everywhere." />
            <SelectField path="model.device" label="Device"
              options={schema.devices.map((d) => ({ value: d, label: d === "auto" ? "auto (NVIDIA GPU, then Intel GPU, then CPU)" : d }))}
              hint="Where detection runs. A CPU handles far fewer cameras than a GPU." />
            <ToggleField path="model.openvino" label="Use OpenVINO"
              hint="Speeds up Intel CPUs and integrated GPUs when there is no NVIDIA GPU. The model is converted once, on first use." />
            <NumberField path="model.imgsz" label="Image size on GPU" unit="px"
              hint="Larger sees small, distant PPE better and costs more time per frame." />
            <NumberField path="model.cpu_imgsz" label="Image size on CPU" unit="px"
              hint="Used instead when detection runs on a CPU, where large sizes are too slow." />
            <NumberField path="model.default_confidence" label="Default confidence" step={0.05}
              hint="Cameras without their own threshold ignore detections scoring below this. Lower finds more and raises more false alarms." />
            <NumberField path="model.iou" label="NMS IoU" step={0.05}
              hint="Boxes overlapping more than this merge into one. Too low merges two workers standing close together." />
            <NumberField path="model.cpu_threads" label="CPU threads" unit="threads" step={1}
              hint="Threads for CPU inference. 0 lets the runtime decide." />
            <ToggleField path="model.half" label="Half precision (FP16)"
              hint="About half the GPU memory and time with no practical loss of accuracy. Ignored on a CPU." />
          </FieldGrid>
        </>
      );
    case "performance": {
      const refine = getIn(draft, "inference.person_refine") ?? true;
      return (
        <>
          <FieldGrid>
            <SelectField path="inference.mode" label="Engine mode"
              options={[{ value: "batched", label: "Batched: one model call serves all cameras" }, { value: "per_stream", label: "Per camera: each camera calls the model itself" }]}
              hint="Batched scales to many cameras on one GPU. Per camera keeps a slow camera from delaying the others." />
            <NumberField path="inference.max_fps_per_stream" label="Max detection rate per camera" unit="fps" step={1}
              hint="Ceiling for each camera. Low-priority cameras get a third of it." />
            <NumberField path="inference.frame_skip" label="Frame skip" unit="frames" step={1}
              hint="Extra captured frames dropped between processed ones. Raise it to cut load when the server is saturated." />
            <NumberField path="inference.process_width" label="Process width" unit="px" step={32}
              hint="Frames are scaled down to this width before detection. Wider helps distant workers and slows every camera." />
            <NumberField path="inference.jpeg_quality" label="Live video JPEG quality" step={5}
              hint="Lower saves bandwidth to each browser and softens the picture. Detection is not affected." />
            <NumberField path="inference.max_batch" label="Max batch" unit="frames" step={1}
              hint="Camera frames per model call. Ready cameras beyond it wait one turn." />
            <NumberField path="inference.post_workers" label="Post-processing workers" unit="threads" step={1}
              hint="Threads that judge compliance and encode video. 0 uses half the CPU cores. Takes effect after a server restart." />
            <NumberField path="inference.decode_threads" label="Decode threads per camera" unit="threads" step={1}
              hint="1 gives the best total throughput with many cameras. 0 lets every camera use every core." />
          </FieldGrid>
          <Group title="Second pass on each worker">
            <FieldGrid>
              <ToggleField path="inference.person_refine" label="Re-check each worker close up" className="sm:col-span-2"
                hint="Runs the model again on a full-resolution crop of every worker, so small helmets and vests are seen. Costs extra model calls per frame." />
              {refine && <>
                <SelectField path="inference.refine_imgsz" numeric label="Close-up size" options={px([224, 256, 288, 320, 384, 416, 480, 640])}
                  hint="Larger is more accurate for distant workers and slower." />
                <NumberField path="inference.refine_max_persons" label="Workers per frame" unit="people" step={1}
                  hint="Only this many get a close-up in one frame. The rest keep the first-pass result." />
                <NumberField path="inference.refine_batch" label="Close-ups per model call" step={1}
                  hint="Higher uses the GPU better and adds a little delay." />
                <NumberField path="inference.refine_min_height" label="Smallest worker re-checked" unit="px" step={1}
                  hint="Workers shorter than this on screen are too small to judge and are skipped." />
              </>}
            </FieldGrid>
          </Group>
          <Group title="Focus mode">
            <FieldGrid>
              <ToggleField path="inference.focus_pause_others" label="Pause other cameras while one is watched full screen"
                hint="Frees the model for the watched camera. Video keeps playing on the others, but violations there are missed meanwhile." />
              <NumberField path="inference.paused_preview_fps" label="Video rate of paused cameras" unit="fps" step={1}
                hint="How smooth a camera looks while its detection is paused." />
            </FieldGrid>
          </Group>
        </>
      );
    }
    case "tracking":
      return (
        <FieldGrid>
          <NumberField path="tracking.low_thresh" label="Weakest detection kept" step={0.05}
            hint="Lowest score that can continue an existing track. Lower holds identities through blur and can add ghost boxes." />
          <NumberField path="tracking.match_iou" label="Match overlap" step={0.05}
            hint="How much a box must overlap the worker's last position to count as the same worker." />
          <NumberField path="tracking.max_lost_seconds" label="Remember a lost worker for" unit="s" step={0.5}
            hint="A worker hidden for less than this keeps their identity, so one incident is not recorded twice." />
          <NumberField path="tracking.min_hits" label="Detections to confirm a worker" unit="frames" step={1}
            hint="Higher filters out one-frame false detections and delays the first verdict." />
        </FieldGrid>
      );
    case "compliance":
      return (
        <FieldGrid>
          <SelectField path="compliance.missing_policy" label="When an item is not seen" className="sm:col-span-2"
            options={[
              { value: "strict", label: "Strict: an item not seen counts as missing" },
              { value: "negative_only", label: "Negative only: only an explicit “no helmet” detection counts" },
            ]}
            hint="Strict catches more, and also flags workers whose PPE is hidden from the camera. Negative only needs a model trained with “no item” classes." />
          <NumberField path="compliance.min_containment" label="PPE on the body" step={0.05}
            hint="Share of a PPE box that must lie on the matching body part to count as worn. Higher rejects a helmet carried in the hand." />
          <NumberField path="compliance.smoothing_window" label="Smoothing window" unit="frames" step={1}
            hint="Each worker's status is a majority vote over this many frames. Longer removes flicker and reacts later." />
          <NumberField path="compliance.min_person_height" label="Smallest worker judged" unit="px" step={1}
            hint="Workers shorter than this on screen are shown as uncertain and never flagged." />
          <NumberField path="analytics.compliance_target" label="Compliance target" step={0.01}
            hint="The goal line on the Analytics compliance trend. 0.95 means 95%." />
        </FieldGrid>
      );
    case "alerts":
      return (
        <>
          <Notice title="Evidence images are what fills the disk">
            Every violation stores a full-resolution original frame, about 0.5 MB each. With long retention the database grows by roughly
            0.5 GB per 1,000 violations. Set “Evidence retention” to drop the images after a while and keep the records.
          </Notice>
          <Group title="When a violation is recorded">
            <FieldGrid>
              <NumberField path="alerts.min_violation_frames" label="Confirm after" unit="frames" step={1}
                hint="Consecutive non-compliant frames before a violation is recorded." />
              <NumberField path="alerts.min_violation_seconds" label="And lasting at least" unit="s" step={0.5}
                hint="Both conditions must hold, so one bad frame never becomes a violation." />
              <NumberField path="alerts.event_gap_seconds" label="Event gap" unit="s" step={1}
                hint="A violation stays one record until the worker is compliant or out of view for this long." />
              <NumberField path="alerts.cooldown_seconds" label="Cooldown per worker" unit="s" step={1}
                hint="Earliest a second violation can be recorded for the same worker, counted from the start of the previous one." />
              <ToggleField path="alerts.require_confident_box" label="Wait for a confident box"
                hint="Holds the alert until the worker's box comes from a confident detection, so the evidence is not a tracker guess." />
              <ToggleField path="alerts.drop_unconfirmed" label="Drop unconfirmed alerts"
                hint="Discards an alert when the full-resolution check finds no person there, such as machinery mistaken for a worker. Needs evidence re-detection." />
            </FieldGrid>
          </Group>
          <Group title="Evidence">
            <FieldGrid>
              <NumberField path="alerts.snapshot_quality" label="Snapshot JPEG quality" step={5}
                hint="Higher is sharper and makes every stored image larger." />
              <SelectField path="alerts.evidence_imgsz" numeric label="Evidence re-detection"
                options={[{ value: "0", label: "Off: use the tracked box" }, ...px([320, 480, 640, 800, 960, 1280])]}
                hint="Finds the worker again on the full-resolution frame so the saved box is exact." />
              <ToggleField path="alerts.save_original_frame" label="Save the original frame" className="sm:col-span-2"
                hint="Keeps the clean full-resolution frame next to the annotated image, for audits and retraining. This is most of each violation's size." />
            </FieldGrid>
          </Group>
          <Group title="Retention">
            <FieldGrid>
              <NumberField path="alerts.retention_days" label="Record retention" unit="days" step={1}
                hint="Violations older than this are deleted with their images. 0 keeps them forever." />
              <NumberField path="alerts.evidence_retention_days" label="Evidence retention" unit="days" step={1}
                hint="Images older than this are deleted; the record and its thumbnail stay. 0 keeps images as long as the record." />
              <TextField path="alerts.db_path" label="Database file" mono className="sm:col-span-2"
                hint="Where violations and evidence are stored. Moving it starts an empty history unless the file is copied too." />
            </FieldGrid>
          </Group>
        </>
      );
    case "alarm":
      return (
        <>
          <FieldGrid>
            <NumberField path="alarm.cooldown_seconds" label="Cooldown per camera" unit="s" step={1}
              hint="Minimum gap between two alarms from the same camera, however many violations it records." />
          </FieldGrid>
          <Group title="Webhook">
            <FieldGrid>
              <ToggleField path="alarm.webhook.enabled" label="Send a webhook" className="sm:col-span-2"
                hint="Posts each violation as JSON to a URL: a hooter or relay gateway, a chat channel, a PLC bridge." />
              <TextField path="alarm.webhook.url" label="URL" mono className="sm:col-span-2" placeholder="https://"
                hint="Receives an HTTP POST. It must be reachable from the server, not from this browser." />
              <NumberField path="alarm.webhook.timeout" label="Timeout" unit="s" step={1}
                hint="A receiver slower than this is given up on and the alarm is lost." />
            </FieldGrid>
          </Group>
          <Group title="Email">
            <FieldGrid>
              <ToggleField path="alarm.email.enabled" label="Send an email" className="sm:col-span-2"
                hint="Mails each violation to the recipients below through your SMTP server." />
              <TextField path="alarm.email.smtp_host" label="SMTP host" mono hint="The mail server that relays the message." />
              <NumberField path="alarm.email.smtp_port" label="SMTP port" step={1} hint="587 with STARTTLS is the usual choice." />
              <ToggleField path="alarm.email.use_tls" label="Use STARTTLS" hint="Encrypts the connection. Turn off only for an open relay inside the plant network." />
              <ToggleField path="alarm.email.attach_snapshot" label="Attach the snapshot" hint="Adds the evidence image to each mail, which makes it larger." />
              <TextField path="alarm.email.username" label="Username" hint="Leave empty if the relay needs no sign-in." />
              <SecretField path="alarm.email.password" label="Password"
                hint="To keep it out of the file, enter ${PPE_SMTP_PASSWORD} and set that environment variable on the server." />
              <TextField path="alarm.email.sender" label="From address" placeholder="ppe-monitor@example.com" hint="Shown as the sender. Some relays reject addresses they do not own." />
              <ListField path="alarm.email.recipients" label="Recipients" placeholder="safety@example.com, shift-lead@example.com"
                hint="Comma-separated addresses. Everyone listed gets every alarm." />
            </FieldGrid>
          </Group>
        </>
      );
    case "server":
      return (
        <FieldGrid>
          <TextField path="server.host" label="Listen address" mono
            hint="0.0.0.0 accepts connections from other machines; 127.0.0.1 limits access to the server itself." />
          <NumberField path="server.port" label="Port" step={1} hint="Changing it changes the address everyone uses to open this application." />
          <TextField path="server.static_dir" label="Web interface folder" mono className="sm:col-span-2"
            hint="The built interface the server hands to browsers. A wrong path leaves only the API reachable." />
          <ListField path="server.cors_origins" label="Allowed origins" className="sm:col-span-2" placeholder="*"
            hint="Comma-separated web origins that may call the API from a browser. * allows any site." />
        </FieldGrid>
      );
  }
}

interface Pending { title: string; changes: CameraChanges; run: (confirm?: string[]) => Promise<SaveResult> }

export function SettingsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const allowed = can("config:system");
  const [doc, setDoc] = useState<ConfigDoc | null>(null);
  const [schema, setSchema] = useState<ConfigSchema | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RawConfig>({});
  const [yaml, setYaml] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [section, setSection] = useState<SectionId>("model");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const adopt = useCallback((d: ConfigDoc) => {
    setDoc(d);
    setDraft(clone(d.config));
    setYaml(d.yaml);
    setErrors([]);
    setConflict(false);
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([api.config.get(), api.config.schema()])
      .then(([d, s]) => { adopt(d); setSchema(s); })
      .catch((e) => setLoadError(errorMessage(e)));
  }, [adopt]);
  useEffect(load, [load]);

  const changed = useMemo(() => (doc ? changedPaths(doc.config, draft) : []), [doc, draft]);
  const formDirty = changed.length > 0;
  const yamlDirty = !!doc && yaml !== doc.yaml;
  const dirty = formDirty || yamlDirty;
  useUnsavedGuard(dirty, "You have unsaved settings. Leave and discard them?");

  // check the form while typing, so a bad value is flagged before the save
  useEffect(() => {
    if (!doc) return;
    if (!formDirty) {
      if (!yamlDirty) setErrors((e) => (e.length ? [] : e));
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      api.config.validate({ config: draft }).then((r) => { if (!stale) setErrors(r.errors); }).catch(() => {});
    }, 600);
    return () => { stale = true; window.clearTimeout(t); };
  }, [draft, doc, formDirty, yamlDirty]);

  const set = useCallback((path: string, value: unknown) => setDraft((d) => setIn(d, path, value)), []);
  const errMap = useMemo(() => Object.fromEntries(errors.map((e) => [e.loc, e.msg])), [errors]);
  const ctx: FormCtx = { draft, saved: doc?.config ?? {}, set, errors: errMap, schema, disabled: !allowed || saving || yamlDirty };

  /** Run a config write. If it would remove cameras the server asks first: confirm, then run it again. */
  const guarded = async (title: string, run: Pending["run"], confirm?: string[]): Promise<boolean> => {
    setSaving(true);
    try {
      const r = await run(confirm);
      adopt(r);
      toastSaved(toast, r, title);
      api.config.schema().then(setSchema).catch(() => {});
      return true;
    } catch (e) {
      const removal = removalRequest(e);
      const fields = fieldErrors(e);
      if (removal) setPending({ title, changes: removal, run });
      else if (isConflict(e)) setConflict(true);
      else if (fields) {
        setErrors(fields);
        const first = fields.map((f) => sectionOf(f.loc)).find(Boolean);
        if (first && !yamlDirty) setSection(first);
        toast({ tone: "error", title: "Nothing was saved", message: `${fields.length} value${fields.length === 1 ? " is" : "s are"} not valid. They are marked on the page.` });
      } else toast({ tone: "error", title: "The settings could not be saved", message: errorMessage(e) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (!doc) return;
    // the draft is the loaded document with only this page's edits, so the cameras go back untouched
    const body = yamlDirty ? { yaml, etag: doc.etag } : { config: draft, etag: doc.etag };
    void guarded("Settings saved", (confirm) => api.config.save({ ...body, confirm_remove: confirm }));
  };

  const closePending = useCallback(() => setPending(null), []);
  const confirmPending = () => {
    if (!pending) return;
    const p = pending;
    setPending(null);
    void guarded(p.title, p.run, p.changes.removed.map((c) => c.id));
  };

  const closeDiscard = useCallback(() => setConfirmDiscard(false), []);
  const discard = () => {
    setConfirmDiscard(false);
    if (doc) adopt(doc);
  };

  /** Someone else saved meanwhile: load their version and put this page's form edits back on top of it. */
  const reloadKeepingEdits = async () => {
    if (!doc) return;
    try {
      const latest = await api.config.get();
      let next = clone(latest.config);
      if (!yamlDirty) for (const p of changed) next = setIn(next, p, getIn(draft, p));
      adopt(latest);
      setDraft(next);
    } catch (e) {
      toast({ tone: "error", title: "The latest settings could not be loaded", message: errorMessage(e) });
    }
  };

  const counts = (id: SectionId) => ({
    edits: id === "advanced" ? (yamlDirty ? 1 : 0) : changed.filter((p) => sectionOf(p) === id).length,
    errors: errors.filter((e) => sectionOf(e.loc) === id).length,
  });
  const active = SECTIONS.find((s) => s.id === section)!;

  let body: ReactNode;
  if (loadError) {
    body = <Notice tone="bad" title="The settings could not be loaded" action={<Button size="sm" onClick={load}>Retry</Button>}>{loadError}</Notice>;
  } else if (!doc || !schema) {
    body = (
      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="hidden flex-col gap-2 lg:flex">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-8" />)}</div>
        <Panel className="p-4">
          <Skeleton className="h-5 w-44" />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-14" />)}</div>
        </Panel>
      </div>
    );
  } else {
    const streamErrors = errors.filter((e) => e.loc.startsWith("streams"));
    const listed = errors.filter((e) => !e.loc.startsWith("streams"));
    body = (
      <>
        <div className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Settings sections" className="hidden lg:sticky lg:top-[calc(var(--topbar-h)+16px)] lg:block">
            <ul className="flex flex-col gap-0.5">
              {SECTIONS.map((s) => {
                const c = counts(s.id);
                const on = s.id === section;
                return (
                  <li key={s.id}>
                    <button type="button" aria-current={on ? "true" : undefined} onClick={() => setSection(s.id)}
                      className={cx("flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm font-medium transition-colors",
                        on ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:bg-sunken hover:text-ink")}>
                      <span className="min-w-0 flex-1 truncate">{s.label}</span>
                      {c.errors > 0 && <Tag tone="bad" title={`${c.errors} value${c.errors === 1 ? "" : "s"} not valid`}>{c.errors} invalid</Tag>}
                      {c.errors === 0 && c.edits > 0 && <Tag tone="accent" title="Unsaved changes in this section">{c.edits} edited</Tag>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="lg:hidden">
            <Select aria-label="Settings section" value={section} onChange={(e) => setSection(e.target.value as SectionId)}>
              {SECTIONS.map((s) => {
                const c = counts(s.id);
                return <option key={s.id} value={s.id}>{s.label}{c.errors ? ` (${c.errors} invalid)` : c.edits ? ` (${c.edits} edited)` : ""}</option>;
              })}
            </Select>
          </div>

          <div className="flex min-w-0 flex-col gap-4 lg:col-start-2">
            {!allowed && <Notice tone="warn">Your role can read these settings but not change them. Changing them needs a Super Admin.</Notice>}
            {conflict && (
              <Notice tone="bad" title="Someone else saved the configuration while you were editing"
                action={<Button size="sm" icon="refresh" onClick={() => void reloadKeepingEdits()}>{yamlDirty ? "Load the latest version" : "Load latest and keep my edits"}</Button>}>
                {yamlDirty
                  ? "Nothing was saved. Loading the latest version replaces the file text below, so copy your edits first if you need them."
                  : "Nothing was saved. Load their version, check that your edits still make sense on top of it, then save again."}
              </Notice>
            )}
            {!yamlDirty && listed.length > 0 && (
              <Notice tone="bad" title={`${listed.length} setting${listed.length === 1 ? " needs" : "s need"} attention before saving`}>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {listed.slice(0, 8).map((e, i) => {
                    const sec = sectionOf(e.loc);
                    return (
                      <li key={i}>
                        {sec
                          ? <button type="button" className="num text-accent-strong underline underline-offset-2" onClick={() => setSection(sec)}>{e.loc}</button>
                          : <span className="num">{e.loc}</span>}: {e.msg}
                      </li>
                    );
                  })}
                  {listed.length > 8 && <li>and {listed.length - 8} more</li>}
                </ul>
              </Notice>
            )}
            {!yamlDirty && streamErrors.length > 0 && (
              <Notice tone="warn" title="A camera's settings are not valid"
                action={<a className="text-[13px] font-medium whitespace-nowrap text-accent-strong underline underline-offset-2" href={href("devices")}>Open Cameras</a>}>
                <span className="num">{streamErrors[0].loc}</span>: {streamErrors[0].msg}. Nothing can be saved until it is fixed.
              </Notice>
            )}

            {section === "advanced" ? (
              <>
                <YamlPanel doc={doc} value={yaml} onChange={setYaml} locked={!allowed || formDirty || saving} serverErrors={yamlDirty ? errors : []} />
                <BackupsPanel etag={doc.etag} disabled={!allowed || dirty || saving}
                  onRestore={(name) => guarded("Backup restored", (confirm) => api.config.restore(name, confirm))} />
                <ResetPanel cameraCount={(doc.config.streams ?? []).length} disabled={!allowed || dirty || saving}
                  onReset={(keep) => guarded(keep ? "Settings reset to defaults" : "Settings reset and cameras removed",
                    (confirm) => api.config.reset({ keep_cameras: keep, confirm_remove: confirm }))} />
                {dirty && <p className="text-xs text-ink-3">Restore and reset are available once there are no unsaved changes.</p>}
              </>
            ) : (
              <Panel>
                <PanelHeader title={active.label} hint={active.hint} />
                <div className="flex flex-col gap-5 p-4">
                  {yamlDirty && <Notice tone="warn">The configuration file has unsaved edits in Advanced. Save or discard them before changing values here.</Notice>}
                  <ConfigFormContext.Provider value={ctx}>
                    <SectionFields id={section} schema={schema} draft={draft} />
                  </ConfigFormContext.Provider>
                </div>
              </Panel>
            )}
          </div>
        </div>

        {dirty && (
          <div className="no-print sticky bottom-3 z-20 mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-line-strong bg-surface px-4 py-2.5 shadow-pop" role="region" aria-label="Unsaved changes">
            <span className="min-w-0 flex-1 text-sm">
              <span className="font-semibold">
                {yamlDirty ? "Unsaved edits to the configuration file" : <><span className="num">{changed.length}</span> unsaved change{changed.length === 1 ? "" : "s"}</>}
              </span>
              <span className="block text-xs text-ink-3">Saving applies them to the running system straight away.</span>
            </span>
            <Button variant="ghost" disabled={saving} onClick={() => setConfirmDiscard(true)}>Discard</Button>
            <Button variant="primary" icon="check" loading={saving} disabled={!allowed || conflict} onClick={save}>Save and apply</Button>
          </div>
        )}
      </>
    );
  }

  return (
    <Page title="Detection settings" description="System-wide configuration: the detection model, how violations are decided and stored, alarms and the server. Cameras and zones have their own page.">
      {allowed || doc || loadError ? body : (
        <Panel><Empty icon="lock" title="Settings are limited to Super Admins">Ask a Super Admin to make the change, or to give your account that role.</Empty></Panel>
      )}

      <ConfirmDialog open={confirmDiscard} onClose={closeDiscard} onConfirm={discard} danger title="Discard unsaved changes?" confirmLabel="Discard changes">
        Your edits are thrown away and the page goes back to the saved configuration.
      </ConfirmDialog>
      <ConfirmDialog open={!!pending} onClose={closePending} onConfirm={confirmPending} danger busy={saving}
        title={pending ? `Remove ${pending.changes.removed.length} camera${pending.changes.removed.length === 1 ? "" : "s"}?` : "Remove cameras?"}
        confirmLabel="Remove and continue">
        {pending && <CameraChangeList changes={pending.changes} />}
      </ConfirmDialog>
    </Page>
  );
}
