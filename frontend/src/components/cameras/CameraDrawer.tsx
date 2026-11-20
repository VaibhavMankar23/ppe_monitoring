/** Editor for one camera (rules, source, zones) in a drawer. Saving writes the whole config document with this camera's changes. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SaveResult } from "../../lib/api";
import { isChecked, phoneProblem } from "../../lib/capabilities";
import { clone, fieldMeta, sameJson } from "../../lib/configForm";
import { ppeLabel } from "../../lib/format";
import { useAuth } from "../../state/auth";
import { useMonitor } from "../../state/monitor";
import type { ConfigDoc, ConfigSchema, FieldError, Priority, RawConfig, StreamInfo, Zone } from "../../types";
import { errorMessage, fieldErrors, isConflict, toastSaved } from "../settings/shared";
import { Button, Chip, ConfirmDialog, cx, Drawer, Field, Icon, Input, Notice, Segmented, Spinner, StatusDot, Switch, Tag, useToast } from "../ui";
import { PASSWORD_MASK, SourceForm } from "./SourceForm";
import { explainProblem, streamStatus } from "./status";
import { ZoneEditor, zoneProblems } from "./ZoneEditor";

export type CameraTab = "rules" | "source" | "zones";
const TAB_LABEL: Record<CameraTab, string> = { rules: "Rules", source: "Source", zones: "Zones" };
const ID_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_ADMIN_KEYS = ["name", "enabled", "required_ppe", "confidence", "priority", "source", "zones"];

const PRIORITY_HELP: Record<Priority, string> = {
  high: "Served first whenever the model cannot keep up with every camera.",
  normal: "Shares the model evenly with the other normal cameras.",
  low: "Checked at a third of the normal rate. Use it where a slightly late alert is acceptable.",
};

const tabOf = (loc: string): CameraTab => (loc.startsWith("source") ? "source" : loc.startsWith("zones") ? "zones" : "rules");

/** id derived from the name: lowercase, [a-z0-9_-], at most 32 characters, not used by another camera. */
function deriveId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  if (!base) return "";
  const used = new Set(taken.map((t) => t.toLowerCase()));
  let id = base;
  for (let n = 2; used.has(id); n++) {
    const suffix = `-${n}`;
    id = base.slice(0, 32 - suffix.length) + suffix;
  }
  return id;
}

/** A new camera that starts like an existing one: same kind of source, user name, PPE rules and priority.
 * Not the name, the zones (they belong to one picture) or the password: a saved password is only ever reused
 * for the camera it was saved with, so it is typed again. */
export function copyOf(c: RawConfig): RawConfig {
  const source: RawConfig = { ...(c.source ?? {}) };
  delete source.password;
  const out: RawConfig = { id: "", name: "", enabled: true, required_ppe: [...(c.required_ppe ?? [])], source };
  for (const k of ["priority", "confidence", "detect_phone"]) if (k in c) out[k] = c[k];
  return out;
}

const without = (o: RawConfig, key: string): RawConfig => {
  const next = { ...o };
  delete next[key];
  return next;
};

interface Props {
  doc: ConfigDoc;
  schema: ConfigSchema;
  /** id of the camera to edit; null creates a new one */
  cameraId: string | null;
  initialTab?: CameraTab;
  /** live state of the camera, when it is known to the monitor */
  stream?: StreamInfo;
  onClose: () => void;
  /** a new camera to start from (Duplicate, Add another like this) */
  template?: RawConfig;
  /** the document after a successful save */
  onSaved: (r: SaveResult) => void;
  /** open a blank new camera that starts like this one */
  onDuplicate: (from: RawConfig) => void;
  /** open a camera (after adding one that does not connect, to fix its source) */
  onEditCamera: (id: string, tab?: CameraTab) => void;
  /** fetch the latest document (after a conflict); the edits in the drawer are kept */
  onReload: () => Promise<void>;
  onDirty: (dirty: boolean) => void;
}

export function CameraDrawer({ doc, schema, cameraId, initialTab, stream, template, onClose, onSaved, onDuplicate, onEditCamera, onReload, onDirty }: Props) {
  const toast = useToast();
  const { can } = useAuth();
  const { streams: liveStreams } = useMonitor();
  const canCameras = can("config:cameras");
  const canSystem = can("config:system");
  const isNew = cameraId === null;
  const streams: RawConfig[] = useMemo(() => doc.config.streams ?? [], [doc]);
  const index = isNew ? -1 : streams.findIndex((s) => s.id === cameraId);
  const saved: RawConfig | undefined = index >= 0 ? streams[index] : undefined;
  const blank = useMemo<RawConfig>(() => ({ id: "", name: "", source: { type: "rtsp", uri: "" }, required_ppe: ["helmet", "vest"], enabled: true }), []);
  const base = isNew ? blank : saved;

  const [draft, setDraft] = useState<RawConfig>(() => clone(isNew && template ? template : base ?? blank));
  const [tab, setTab] = useState<CameraTab>(initialTab ?? (isNew ? "source" : "rules"));
  const [idEdited, setIdEdited] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]); // loc relative to this camera: "name", "source.uri", "zones.0.name"
  const [otherErrors, setOtherErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** how the connection test of the source in the form went; null = not tested since the source last changed */
  const [tested, setTested] = useState<{ ok: boolean; message?: string } | null>(null);
  const [confirmAdd, setConfirmAdd] = useState(false);
  /** a new camera that was just saved: the drawer then shows whether it connected */
  const [added, setAdded] = useState<{ id: string; name: string; camera: RawConfig } | null>(null);
  const onTested = useCallback((outcome: "ok" | "failed" | null, message?: string) => setTested(outcome === null ? null : { ok: outcome === "ok", message }), []);

  const dirty = !added && !!base && !sameJson(draft, base);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  // Drawer and dialogs re-attach their key handling whenever onClose changes, so these stay stable.
  const state = useRef({ dirty, saving, nested: confirmClose || confirmRemove || confirmAdd });
  state.current = { dirty, saving, nested: confirmClose || confirmRemove || confirmAdd };
  const requestClose = useCallback(() => {
    const s = state.current;
    if (s.nested || s.saving) return;
    if (s.dirty) setConfirmClose(true);
    else onClose();
  }, [onClose]);
  const closeConfirmClose = useCallback(() => setConfirmClose(false), []);
  const closeConfirmRemove = useCallback(() => setConfirmRemove(false), []);

  const adminKeys = schema.admin_stream_keys ?? DEFAULT_ADMIN_KEYS;
  /** May this role change this key of the camera? Mirrors the server's rule. */
  const editable = (key: string) => !saving && (canSystem || (canCameras && !isNew && adminKeys.includes(key)));
  const anyEditable = canSystem || (canCameras && !isNew);

  const errMap = useMemo(() => Object.fromEntries(errors.map((e) => [e.loc, e.msg])), [errors]);
  const set = (key: string, value: unknown) => {
    setDraft((d) => (value === undefined ? without(d, key) : { ...d, [key]: value }));
    setErrors((es) => (es.some((e) => e.loc === key) ? es.filter((e) => e.loc !== key) : es));
  };
  /** Clearing an optional key the saved camera never had removes it again, so the camera reads as unchanged. */
  const setOptional = (key: string, value: unknown, empty: unknown) =>
    set(key, sameJson(value, empty) && !(base && key in base) ? undefined : value);

  const otherIds = streams.filter((_, i) => i !== index).map((s) => String(s.id));
  const setName = (name: string) => {
    setDraft((d) => ({ ...d, name, ...(isNew && !idEdited ? { id: deriveId(name, otherIds) } : {}) }));
    setErrors((es) => es.filter((e) => e.loc !== "name" && e.loc !== "id"));
  };

  const zones: Zone[] = draft.zones ?? [];
  const ppe: string[] = draft.required_ppe ?? [];
  const caps = schema.capabilities;
  const unchecked = ppe.filter((p) => !isChecked(p, caps));
  const confMeta = fieldMeta(schema.schema, "streams.0.confidence");
  const defaultConf = Number(doc.config.model?.default_confidence ?? fieldMeta(schema.schema, "model.default_confidence").default ?? 0.35);
  const conf: number | null = typeof draft.confidence === "number" ? draft.confidence : null;
  const priority: Priority = draft.priority ?? "normal";
  const phoneIssue = draft.detect_phone ? phoneProblem(doc.config.model?.phone_weights, caps) : null;
  const hasRestricted = zones.some((z) => z.type === "restricted");

  // ---------------------------------------------------------------- save
  const check = (): FieldError[] => {
    const out: FieldError[] = [];
    const name = String(draft.name ?? "").trim();
    if (!name) out.push({ loc: "name", msg: "Give the camera a name." });
    else if (name.length > 64) out.push({ loc: "name", msg: "Use 64 characters or fewer." });
    if (isNew) {
      const id = String(draft.id ?? "");
      if (!id) out.push({ loc: "id", msg: "Enter an ID, or a name to derive it from." });
      else if (!ID_RE.test(id)) out.push({ loc: "id", msg: "Use only letters, digits, - and _." });
      else if (id.length > 32) out.push({ loc: "id", msg: "Use 32 characters or fewer." });
      else if (otherIds.some((o) => o.toLowerCase() === id.toLowerCase())) out.push({ loc: "id", msg: "Another camera already has this ID." });
    }
    if (!String(draft.source?.uri ?? "").trim()) out.push({ loc: "source.uri", msg: "Say where the video comes from." });
    zoneProblems(zones).forEach((p, i) => { if (p) out.push({ loc: `zones.${i}.name`, msg: `${zones[i].name || `Zone ${i + 1}`}: ${p}` }); });
    return out;
  };

  const fail = (found: FieldError[], others: FieldError[] = []) => {
    setErrors(found);
    setOtherErrors(others);
    if (found.length && !found.some((e) => tabOf(e.loc) === tab)) setTab(tabOf(found[0].loc));
  };

  const handleError = (e: unknown, what: string) => {
    const fields = fieldErrors(e);
    if (isConflict(e)) setConflict(true);
    else if (fields) {
      // the server names a camera by its position ("streams.2.source.uri") or its id ("streams.gate.source.password")
      const at = isNew ? streams.length : index;
      const prefixes = [`streams.${at}.`, `streams.${draft.id}.`];
      const mine: FieldError[] = [], others: FieldError[] = [];
      for (const f of fields) {
        const p = prefixes.find((x) => f.loc.startsWith(x));
        if (p) mine.push({ ...f, loc: f.loc.slice(p.length) });
        else if (f.loc === `streams.${at}`) mine.push({ ...f, loc: "" });
        else others.push(f);
      }
      fail(mine, others);
      toast({ tone: "error", title: "Nothing was saved", message: `${fields.length} value${fields.length === 1 ? " is" : "s are"} not valid. They are marked in the editor.` });
    } else toast({ tone: "error", title: what, message: errorMessage(e) });
  };

  const save = async (force = false) => {
    const found = check();
    if (found.length) {
      fail(found);
      return;
    }
    if (isNew && !force && tested?.ok === false) {  // the test said no: ask once, do not block (the camera may be off for now)
      setConfirmAdd(true);
      return;
    }
    const camera = { ...draft, name: String(draft.name).trim(), source: { ...draft.source, uri: String(draft.source.uri).trim() } };
    const next = clone(doc.config);
    next.streams = [...streams];
    if (isNew) next.streams.push(camera);
    else next.streams[index] = camera;
    setSaving(true);
    try {
      const r = await api.config.save({ config: next, etag: doc.etag });
      toastSaved(toast, r, isNew ? `Camera “${camera.name}” added` : `Camera “${camera.name}” saved`);
      onDirty(false);
      onSaved(r);
      if (isNew) setAdded({ id: String(draft.id), name: camera.name, camera: camera as RawConfig });  // stay: show whether it connected
      else onClose();
    } catch (e) {
      handleError(e, "The camera could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (isNew || index < 0) return;
    const next = clone(doc.config);
    next.streams = streams.filter((_, i) => i !== index);
    setSaving(true);
    try {
      const r = await api.config.save({ config: next, etag: doc.etag, confirm_remove: [String(cameraId)] });
      toastSaved(toast, r, `Camera “${saved?.name ?? cameraId}” removed`);
      onDirty(false);
      onSaved(r);
      onClose();
    } catch (e) {
      setConfirmRemove(false);
      handleError(e, "The camera could not be removed");
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    try {
      await onReload();
      setConflict(false);
    } catch (e) {
      toast({ tone: "error", title: "The latest configuration could not be loaded", message: errorMessage(e) });
    }
  };

  // ---------------------------------------------------------------- render
  const status = streamStatus(stream, draft.enabled !== false);
  const tabErrors = (t: CameraTab) => errors.filter((e) => tabOf(e.loc) === t).length;
  const sourceErrors = useMemo(() => Object.fromEntries(errors.filter((e) => e.loc.startsWith("source.")).map((e) => [e.loc.slice(7), e.msg])), [errors]);
  const zoneErrors = useMemo(() => errors.filter((e) => e.loc === "zones" || e.loc.startsWith("zones."))
    // name problems found here are already shown on each zone's row
    .filter((e) => !/^zones\.\d+\.name$/.test(e.loc) || !zoneProblems(zones).some(Boolean))
    .map((e) => ({ ...e, loc: e.loc.slice(6) })), [errors, zones]);
  const gone = !isNew && !saved;
  const problem = !isNew ? explainProblem(stream) : null;
  const rawProblem = !isNew && !problem && stream?.running && ["offline", "error", "no_source"].includes(stream.status) ? stream.message : "";

  return (
    <>
      <Drawer open onClose={requestClose} width={880}
        title={added ? `Camera added: ${added.name}` : isNew ? (draft.name ? `New camera: ${draft.name}` : "New camera") : draft.name || cameraId}
        subtitle={added ? <span className="num">{added.id}</span> : isNew ? "It starts as soon as it is saved." : (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="num">{cameraId}</span>
            <span className="flex items-center gap-1.5" title={stream?.message || undefined}><StatusDot tone={status.tone} pulse={status.tone === "ok"} />{status.label}</span>
          </span>
        )}
        footer={added ? (
          <>
            <Button variant="ghost" onClick={() => onEditCamera(added.id)}>Edit this camera</Button>
            <Button icon="plus" onClick={() => onDuplicate(added.camera)}>Add another like this</Button>
            <Button variant="primary" icon="check" onClick={onClose}>Done</Button>
          </>
        ) : gone ? <Button variant="primary" onClick={onClose}>Close</Button> : (
          <>
            <div className="mr-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              {!isNew && canSystem && (
                <Button variant="ghost" icon="trash" className="text-bad! hover:bg-bad-soft!" disabled={saving} onClick={() => setConfirmRemove(true)}>Remove camera</Button>
              )}
              {!isNew && canSystem && (
                <Button variant="ghost" icon="plus" disabled={saving || dirty} title={dirty ? "Save or discard your changes first" : "Start a new camera from this one's settings"}
                  onClick={() => saved && onDuplicate(saved)}>Duplicate</Button>
              )}
              <span className={cx("text-xs", isNew && tested?.ok === false ? "text-bad" : "text-ink-3")}>
                {!isNew ? "Saving restarts this camera. The others keep running."
                  : tested === null ? "Not tested yet. Saving adds the camera and starts it."
                    : tested.ok ? "Connection tested. Saving adds the camera and starts it."
                      : "The last connection test failed."}
              </span>
            </div>
            <Button variant="ghost" disabled={saving} onClick={requestClose}>{dirty ? "Discard" : "Close"}</Button>
            <Button variant="primary" icon="check" loading={saving} disabled={!anyEditable || !dirty || conflict} onClick={() => void save()}>{isNew ? "Add camera" : "Save camera"}</Button>
          </>
        )}>
        {added ? (
          <div className="p-4">
            <AddedResult stream={liveStreams.find((x) => x.id === added.id)} onFix={() => onEditCamera(added.id, "source")} />
          </div>
        ) : gone ? (
          <div className="p-4"><Notice tone="warn" title="This camera is no longer in the configuration">Someone removed it while this editor was open. Your changes to it cannot be saved.</Notice></div>
        ) : (
          <div className="flex flex-col gap-4 p-4">
            {/* a new camera is one short page (name, source, PPE); the tabs and the rest come when editing it */}
            {!isNew && <div className="flex flex-wrap items-center gap-3">
              <Segmented label="Camera settings" value={tab} onChange={setTab}
                options={(Object.keys(TAB_LABEL) as CameraTab[]).map((t) => ({
                  value: t, count: t === "zones" ? zones.length : undefined,
                  label: <>{TAB_LABEL[t]}{tabErrors(t) > 0 && <span className="flex items-center gap-1 text-bad"><Icon name="alert" size={12} /><span className="sr-only">has problems</span></span>}</>,
                }))} />
            </div>}

            {!canCameras ? <Notice tone="warn">Your role can look at cameras but not change them.</Notice>
              : !canSystem && isNew ? <Notice tone="warn">Adding a camera needs a Super Admin.</Notice>
                : !canSystem && <Notice>Your role can change this camera's name, source, rules and zones. Removing it, and phone-use detection, need a Super Admin.</Notice>}

            {isNew && template && (
              <Notice>Started from another camera: same kind of source, user name, PPE rules and priority. Change the name and the address. Enter the password again: a saved password is only reused for the camera it was saved with.</Notice>
            )}
            {problem && (
              <Notice tone="bad" title={problem.title}
                action={problem.tab && tab !== problem.tab ? <Button size="sm" onClick={() => setTab(problem.tab!)}>Open {TAB_LABEL[problem.tab]}</Button> : undefined}>
                {problem.fix}
              </Notice>
            )}
            {rawProblem && <Notice tone="bad" title="Not working right now"><span className="break-words">{rawProblem}</span></Notice>}

            {conflict && (
              <Notice tone="bad" title="Someone else saved the configuration while you were editing"
                action={<Button size="sm" icon="refresh" onClick={() => void reload()}>Load latest and keep my edits</Button>}>
                Nothing was saved. Load their version, then save this camera again.
              </Notice>
            )}
            {(errors.length > 0 || otherErrors.length > 0) && (
              <Notice tone="bad" title="Nothing was saved. Fix these first:">
                <ul className="mt-1 flex flex-col gap-0.5">
                  {errors.map((e, i) => (
                    <li key={i}>
                      <button type="button" className="font-medium text-accent-strong underline underline-offset-2" onClick={() => setTab(tabOf(e.loc))}>{TAB_LABEL[tabOf(e.loc)]}</button>
                      {e.loc && !e.loc.startsWith("zones") && <span className="num"> {e.loc}</span>}: {e.msg}
                    </li>
                  ))}
                  {otherErrors.map((e, i) => <li key={`o${i}`}>Elsewhere in the configuration, <span className="num">{e.loc}</span>: {e.msg}</li>)}
                </ul>
              </Notice>
            )}

            {(tab === "rules" || isNew) && (
              <div className="flex flex-col gap-5">
                <div className={cx("grid gap-4", !isNew && "sm:grid-cols-2")}>
                  <Field label="Name" error={errMap.name} hint="Shown on the live wall, in alerts and in reports.">
                    {(id) => <Input id={id} value={draft.name ?? ""} maxLength={64} disabled={!editable("name")} invalid={!!errMap.name} placeholder="Gate 2, loading bay"
                      onChange={(e) => setName(e.target.value)} />}
                  </Field>
                  {!isNew && (
                    <Field label="Camera ID" error={errMap.id} hint="Fixed. Violation history is filed under it.">
                      {(id) => <Input id={id} className="num" value={draft.id ?? ""} maxLength={32} disabled invalid={!!errMap.id} spellCheck={false}
                        onChange={(e) => { setIdEdited(true); set("id", e.target.value); }} />}
                    </Field>
                  )}
                </div>

                {isNew && (
                  <div>
                    <div className="mb-2 text-[13px] font-semibold">Video source</div>
                    <SourceForm essential source={draft.source ?? {}} onChange={(s) => { set("source", s); setErrors((es) => es.filter((e) => !e.loc.startsWith("source"))); }}
                      hasStoredPassword={false} disabled={!editable("source")} canUpload={canSystem} schema={schema} errors={sourceErrors} onTested={onTested} />
                  </div>
                )}

                {!isNew && (
                  <Switch checked={draft.enabled !== false} disabled={!editable("enabled")} onChange={(v) => setOptional("enabled", v, true)} label="Enabled"
                    hint="Runs whenever the server runs. Off keeps the camera and its history, but nothing is watched." />
                )}

                <div>
                  <div className="mb-1.5 text-[13px] font-medium" id="cam-ppe">Required PPE</div>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="cam-ppe">
                    {/* a new camera offers only what the model can check; editing shows everything, flagged */}
                    {(isNew ? schema.ppe_items.filter((item) => isChecked(item, caps)) : schema.ppe_items).map((item) => {
                      const on = ppe.includes(item);
                      return (
                        <Chip key={item} selected={on} disabled={!editable("required_ppe")}
                          title={isChecked(item, caps) ? undefined : "Not detected by the loaded model"}
                          onClick={() => set("required_ppe", on ? ppe.filter((p) => p !== item) : [...ppe, item])}>
                          {ppeLabel(item)}{!isChecked(item, caps) && <Icon name="eyeOff" size={12} />}
                        </Chip>
                      );
                    })}
                  </div>
                  {errMap.required_ppe ? <p role="alert" className="mt-1.5 text-xs text-bad">{errMap.required_ppe}</p> : (
                    <p className="mt-1.5 text-xs text-ink-3">
                      {ppe.length === 0
                        ? hasRestricted || draft.detect_phone ? "No PPE is required here. Only restricted areas and phone use raise violations." : "No PPE is required here, so this camera never raises a violation."
                        : "A worker missing any selected item is in violation."}
                    </p>
                  )}
                  {unchecked.length > 0 && (
                    <div className="mt-2 rounded-md bg-warn-soft px-3 py-2">
                      <div className="flex flex-wrap gap-1.5">
                        {unchecked.map((p) => <Tag key={p} tone="warn" icon="eyeOff" className="bg-surface!">{ppeLabel(p)}: not detected by this model</Tag>)}
                      </div>
                      <p className="mt-1.5 text-xs text-ink-2">
                        {unchecked.length === 1 ? "This item is" : "These items are"} required on paper but will not be enforced: the loaded model has no class for
                        {unchecked.length === 1 ? " it" : " them"}, so no violation is ever raised. Load a model that detects {unchecked.length === 1 ? "it" : "them"} in Settings.
                      </p>
                    </div>
                  )}
                </div>

                {!isNew && <>
                <div>
                  <div className="mb-1.5 text-[13px] font-medium">Detection confidence</div>
                  <Switch checked={conf === null} disabled={!editable("confidence")}
                    onChange={(v) => set("confidence", v ? (base && "confidence" in base ? null : undefined) : defaultConf)}
                    label={<>Use the system default <span className="num text-ink-3">({defaultConf.toFixed(2)})</span></>} />
                  {conf !== null && (
                    <div className="mt-2 flex items-center gap-3">
                      <input type="range" aria-label="Detection confidence for this camera" className="h-9 min-w-0 flex-1 accent-(--color-accent) sm:max-w-sm"
                        min={confMeta.minimum ?? 0.05} max={confMeta.maximum ?? 0.95} step={0.05} value={conf} disabled={!editable("confidence")}
                        onChange={(e) => set("confidence", Math.round(Number(e.target.value) * 100) / 100)} />
                      <output className="num w-12 text-sm font-semibold">{conf.toFixed(2)}</output>
                    </div>
                  )}
                  {errMap.confidence ? <p role="alert" className="mt-1 text-xs text-bad">{errMap.confidence}</p>
                    : <p className="mt-1.5 text-xs text-ink-3">Detections scoring below this are ignored. Lower catches more in poor light or at a distance, and raises more false alarms.</p>}
                </div>

                <div>
                  <div className="mb-1.5 text-[13px] font-medium">Priority</div>
                  {editable("priority") ? (
                    <Segmented label="Priority" value={priority} onChange={(v) => setOptional("priority", v, "normal")}
                      options={[{ value: "high", label: "High" }, { value: "normal", label: "Normal" }, { value: "low", label: "Low" }]} />
                  ) : <Tag>{priority}</Tag>}
                  <p className="mt-1.5 text-xs text-ink-3">{PRIORITY_HELP[priority]}</p>
                  {errMap.priority && <p role="alert" className="mt-1 text-xs text-bad">{errMap.priority}</p>}
                </div>

                <div>
                  <Switch checked={!!draft.detect_phone} disabled={!editable("detect_phone")} onChange={(v) => setOptional("detect_phone", v, false)}
                    label={<span className="flex items-center gap-1.5"><Icon name="phone" size={14} />Detect phone use</span>}
                    hint="Raises a “Phone use” violation when a worker holds a phone to their hands or face. It runs a second model on this camera, which adds load." />
                  {phoneIssue && <Notice tone="warn" className="mt-2" title="Phone use is not being checked">{phoneIssue}</Notice>}
                </div>
                </>}
              </div>
            )}

            {tab === "source" && !isNew && (
              <SourceForm source={draft.source ?? {}} onChange={(s) => { set("source", s); setErrors((es) => es.filter((e) => !e.loc.startsWith("source"))); }}
                hasStoredPassword={saved?.source?.password === PASSWORD_MASK} streamId={isNew ? undefined : String(cameraId)}
                disabled={!editable("source")} canUpload={canSystem} schema={schema} errors={sourceErrors} />
            )}

            {tab === "zones" && !isNew && (
              <ZoneEditor zones={zones} disabled={!editable("zones")} streamId={isNew ? undefined : String(cameraId)} stream={stream} source={draft.source}
                errors={zoneErrors}
                onChange={(z) => { setOptional("zones", z, []); setErrors((es) => es.filter((e) => !e.loc.startsWith("zones"))); }} />
            )}
          </div>
        )}
      </Drawer>

      <ConfirmDialog open={confirmClose} onClose={closeConfirmClose} onConfirm={() => { setConfirmClose(false); onDirty(false); onClose(); }} danger
        title="Discard changes to this camera?" confirmLabel="Discard changes">
        {isNew ? "The new camera is not added." : "The camera keeps the settings it had when you opened it."}
      </ConfirmDialog>
      <ConfirmDialog open={confirmAdd} onClose={() => setConfirmAdd(false)} onConfirm={() => { setConfirmAdd(false); void save(true); }}
        title="The connection test failed" confirmLabel="Add anyway">
        {tested?.message ? <span className="break-words">{tested.message} </span> : null}
        The camera will be added, but it will show as offline until the address, port or sign-in is fixed. Add it anyway?
      </ConfirmDialog>
      <ConfirmDialog open={confirmRemove} onClose={closeConfirmRemove} onConfirm={() => void remove()} danger busy={saving}
        title={`Remove ${saved?.name ?? "this camera"}?`} confirmLabel="Remove camera">
        The camera stops now and leaves the configuration, with its rules and zones. Violations it already recorded are kept.
        {dirty && " Your unsaved changes to it are dropped."}
      </ConfirmDialog>
    </>
  );
}


/** What the person who just added a camera needs to see: did it connect, and if not, why and what to do. */
function AddedResult({ stream, onFix }: { stream: StreamInfo | undefined; onFix: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 20_000);
    return () => window.clearTimeout(t);
  }, []);
  const problem = explainProblem(stream);
  const failed = !!stream && ["offline", "error", "no_source"].includes(stream.status);

  if (stream?.status === "live") {
    return (
      <Notice tone="ok" title="Connected and watching">
        {stream.frame_size ? `${stream.frame_size[0]} × ${stream.frame_size[1]}` : "Video is arriving"}
        {stream.source_fps ? `, ${Math.round(stream.source_fps * 10) / 10} fps from the camera` : ""}. It appears on the Live page now. Draw zones from its Zones tab if only part of the picture matters.
      </Notice>
    );
  }
  if (failed) {
    return (
      <Notice tone="bad" title={problem?.title ?? "The camera was added, but it is not connecting"}
        action={<Button size="sm" onClick={onFix}>Fix the source</Button>}>
        {problem && <p>{problem.fix}</p>}
        {stream?.message && <p className={cx("break-words", problem && "mt-1 text-xs text-ink-3")}>{stream.message}</p>}
      </Notice>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[13.5px] text-ink-2" role="status"><Spinner size={16} /> {stream ? "Connecting to the camera…" : "Starting the camera…"}</div>
      {slow && <Notice tone="warn">This is taking longer than usual. A network camera can need up to 20 seconds. If it stays here, use Edit this camera and test the connection.</Notice>}
    </div>
  );
}
