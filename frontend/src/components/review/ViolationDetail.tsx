import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, jpegDataUrl, saveBlob } from "../../lib/api";
import { fmtDateTime, fmtDuration, fmtPct, fmtTime, ppeLabel, violationLabel } from "../../lib/format";
import type { Verdict, Violation, ViolationMeta } from "../../types";
import { Button, Chip, ConfirmDialog, cx, Icon, Input, Kbd, Notice, Segmented, Skeleton, Spinner, Tag, useToast } from "../ui";
import { b64ToBlob, dialogOpen, isTyping, VERDICT_LABEL, type Reason, type ReviewPatch } from "./shared";

type Tab = "evidence" | "crop" | "original";
const TAB_LABEL: Record<Tab, string> = { evidence: "Evidence", crop: "Person crop", original: "Original frame" };
const TAB_CAPTION: Record<Tab, string> = {
  evidence: "Annotated frame the system saved as evidence",
  crop: "The flagged person, cropped from the full-resolution frame",
  original: "The camera frame without annotations",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 border-b border-line px-4 py-2 text-[13px] last:border-b-0">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

const SETTING_LABEL: Record<string, string> = {
  confidence_threshold: "Confidence threshold",
  required_ppe: "Required PPE",
  behaviors: "Behaviours checked",
  not_checked: "Configured but not checked",
  zones: "Zones",
  missing_policy: "Missing-item policy",
  min_containment: "Min. containment",
  min_person_height: "Min. person height",
  smoothing_window: "Smoothing window (frames)",
  min_violation_frames: "Min. violation frames",
  min_violation_seconds: "Min. violation seconds",
  event_gap_seconds: "Event gap (s)",
  cooldown_seconds: "Cooldown (s)",
  evidence_imgsz: "Evidence image size",
  config_sha256: "Config SHA-256",
};

function settingValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "–";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (!value.length) return "None";
    return value.map((x) => {
      if (typeof x === "string") return key === "zones" ? x : ppeLabel(x);
      if (x && typeof x === "object" && "name" in x) {
        const z = x as { name: unknown; type?: unknown };
        return z.type ? `${String(z.name)} (${String(z.type)})` : String(z.name);
      }
      return JSON.stringify(x);
    }).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const Sha = ({ value }: { value: string }) => <span className="num" title={value}>{value.slice(0, 12)}…</span>;

function Provenance({ meta }: { meta: ViolationMeta }) {
  const m = meta.model;
  const settings = Object.entries(meta.settings ?? {});
  if (!m && !settings.length) return null;
  return (
    <details className="group border-t border-line">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <Icon name="chevronRight" size={14} className="transition-transform group-open:rotate-90" />
        How this was detected
      </summary>
      <dl className="border-t border-line">
        {m?.weights && <Row label="Model weights"><span className="num">{m.weights}</span></Row>}
        {m?.sha256 && <Row label="Model SHA-256"><Sha value={m.sha256} /></Row>}
        {m?.runtime && <Row label="Runtime">{m.runtime}</Row>}
        {m?.device && <Row label="Device">{m.device}</Row>}
        {m?.imgsz !== undefined && <Row label="Inference size"><span className="num">{m.imgsz}</span> px</Row>}
        {m?.phone_model?.weights && (
          <Row label="Phone model">
            <span className="num">{m.phone_model.weights}</span>
            {m.phone_model.sha256 && <> · <Sha value={m.phone_model.sha256} /></>}
          </Row>
        )}
        {settings.map(([k, val]) => (
          <Row key={k} label={SETTING_LABEL[k] ?? k.replace(/_/g, " ")}>
            {k.endsWith("sha256") && typeof val === "string" ? <Sha value={val} /> : <span className={typeof val === "number" ? "num" : undefined}>{settingValue(k, val)}</span>}
          </Row>
        ))}
        {meta.camera?.run_id && <Row label="Camera run"><span className="num">{meta.camera.run_id}</span></Row>}
      </dl>
    </details>
  );
}

interface Props {
  id: number;
  /** the list row, when the violation is in the loaded list: shown at once and kept live */
  item?: Violation;
  reasons: Reason[];
  canReview: boolean;
  canDelete: boolean;
  /** rendered inside the mobile drawer (which is itself a dialog) */
  inDrawer?: boolean;
  onReviewed: (id: number, patch: ReviewPatch) => void;
  onDeleted: (id: number) => void;
}

/**
 * One violation: evidence viewer, verdict bar and provenance. Mount with `key={id}` so every
 * piece of per-violation state (tab, reason picker, lazy images) resets on selection.
 */
export function ViolationDetail({ id, item, reasons, canReview, canDelete, inDrawer = false, onReviewed, onDeleted }: Props) {
  const toast = useToast();
  const [full, setFull] = useState<Violation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<Tab>("evidence");
  const [extra, setExtra] = useState<Partial<Record<"crop" | "original", string>>>({});
  const [extraError, setExtraError] = useState<string | null>(null);
  const [extraAttempt, setExtraAttempt] = useState(0);
  const [picker, setPicker] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Verdict | "undo" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let on = true;
    setLoadError(null);
    api.violations.get(id)
      .then((v) => on && setFull(v))
      .catch((e) => on && setLoadError((e as Error).message));
    return () => { on = false; };
  }, [id, attempt]);

  // live fields come from the list row (kept current over the WebSocket); everything else from the full record
  const v: Violation | undefined = full
    ? (item ? { ...full, state: item.state, last_seen: item.last_seen ?? full.last_seen, duration: item.duration ?? full.duration,
        observations: item.observations ?? full.observations, missing: item.missing } : full)
    : item;
  const review = v?.review ?? null;
  const purgedAt = v?.evidence_purged_at ?? null;
  const available: Record<Tab, boolean> = { evidence: true, crop: !!full?.has_crop && !purgedAt, original: !!full?.has_original && !purgedAt };

  // original / crop are large: fetch only when their tab is opened
  useEffect(() => {
    if (tab === "evidence" || extra[tab] !== undefined) return;
    let on = true;
    setExtraError(null);
    api.violations.get(id, [tab])
      .then((r) => on && setExtra((x) => ({ ...x, [tab]: r[tab] ?? "" })))
      .catch((e) => on && setExtraError((e as Error).message));
    return () => { on = false; };
  }, [id, tab, extra, extraAttempt]);

  const shown = tab === "evidence" ? full?.image : extra[tab];
  const downloadShown = () => {
    if (!shown) return;
    try { saveBlob(b64ToBlob(shown), `violation-${id}-${tab}.jpg`); }
    catch { toast({ tone: "error", title: "Couldn't save the image", message: "The image data is damaged." }); }
  };

  const submit = useCallback(async (verdict: Verdict | null, why?: string, text = "") => {
    setBusy(verdict ?? "undo");
    try {
      const r = await api.violations.review(id, verdict, why, text);
      const patch: ReviewPatch = { review: r.review ?? null, acknowledged_at: r.acknowledged_at ?? null, acknowledged_by: r.acknowledged_by ?? null };
      if (alive.current) {
        setFull((f) => (f ? { ...f, ...patch } : f));
        setPicker(false);
        setReason("");
        setNote("");
      }
      onReviewed(id, patch);
    } catch (e) {
      toast({ tone: "error", title: verdict ? "Couldn't save the verdict" : "Couldn't undo the review", message: (e as Error).message });
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [id, onReviewed, toast]);

  const saveFalseAlarm = (e?: FormEvent) => {
    e?.preventDefault();
    if (!reason || busy) return;
    void submit("false_alarm", reason, note.trim());
  };
  const openPicker = () => {
    setPicker(true);
    if (reasons.length === 1) setReason(reasons[0].id);
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.violations.remove(id);
      toast({ tone: "success", title: "Violation deleted" });
      onDeleted(id);
    } catch (e) {
      toast({ tone: "error", title: "Couldn't delete the violation", message: (e as Error).message });
      if (alive.current) { setDeleting(false); setConfirmDelete(false); }
    }
  };

  // V / F / 1-9 / Enter / Esc. Bound once; the handler reads the latest state through a ref.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !canReview || !v || review || busy) return;
    if (dialogOpen(inDrawer ? 1 : 0)) return;
    if (e.key === "Escape" && picker) {
      setPicker(false);
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    if (isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === "v") { e.preventDefault(); void submit("valid"); }
    else if (k === "f") { e.preventDefault(); openPicker(); }
    else if (picker && /^[1-9]$/.test(k) && reasons[Number(k) - 1]) { e.preventDefault(); setReason(reasons[Number(k) - 1].id); }
    else if (picker && e.key === "Enter" && reason && !(e.target as HTMLElement | null)?.closest?.("form")) { e.preventDefault(); saveFalseAlarm(); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (!v) {
    return loadError ? (
      <div className="p-4">
        <Notice tone="bad" title="Couldn't load this violation" action={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>{loadError}</Notice>
      </div>
    ) : (
      <div aria-busy="true">
        <Skeleton className="h-[min(50vh,540px)] min-h-56 w-full rounded-none" />
        <div className="space-y-3 p-4">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
    );
  }

  const meta = v.meta ?? null;
  const det = meta?.detection;
  const life = meta?.lifecycle;
  const personConf = det?.person_confidence ?? null;
  const reasonLabel = (rid: string | null) => (rid ? reasons.find((r) => r.id === rid)?.label ?? rid.replace(/_/g, " ") : null);
  const ongoing = v.state === "ongoing";

  const body = (
    <>
      {!inDrawer && (
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-2.5">
          <h2 className="min-w-0 truncate text-sm font-semibold">{v.stream_name}</h2>
          <time className="num text-[13px] text-ink-2">{fmtDateTime(v.timestamp)}</time>
          <span className="flex flex-wrap items-center gap-1">
            {v.missing.map((m) => <Tag key={m} tone="bad">{violationLabel(m)}</Tag>)}
            {ongoing && <Tag tone="accent">Ongoing</Tag>}
          </span>
        </header>
      )}

      {/* ---- evidence viewer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <Segmented<Tab> size="sm" label="Evidence image" value={tab}
          onChange={(t) => available[t] && setTab(t)}
          options={(Object.keys(TAB_LABEL) as Tab[]).map((t) => ({
            value: t,
            label: available[t] ? TAB_LABEL[t] : <span aria-disabled="true" className="cursor-not-allowed opacity-40" title="Not stored for this violation">{TAB_LABEL[t]}</span>,
          }))} />
        <Button size="sm" variant="ghost" icon="download" disabled={!shown || !!purgedAt} onClick={downloadShown}>Download image</Button>
      </div>
      <div className="relative flex h-[min(36vh,500px)] min-h-56 items-center justify-center overflow-hidden bg-stage">
        {purgedAt ? (
          <div className="max-w-sm px-6 text-center">
            <Icon name="eyeOff" size={24} className="mx-auto text-stage-ink-2" />
            <p className="mt-2 text-sm font-medium text-stage-ink">Evidence images were removed</p>
            <p className="mt-1 text-[13px] text-stage-ink-2">
              The retention policy deleted them on <span className="num">{fmtDateTime(purgedAt)}</span>. The record and its verdict are kept.
            </p>
          </div>
        ) : shown ? (
          <img src={jpegDataUrl(shown)} alt={`${TAB_LABEL[tab]} for the violation on ${v.stream_name} at ${fmtTime(v.timestamp)}`}
            className="max-h-full max-w-full object-contain" />
        ) : (tab === "evidence" ? loadError : extraError) ? (
          <div className="max-w-sm px-6 text-center">
            <p className="text-sm font-medium text-stage-ink">Couldn't load the image</p>
            <p className="mt-1 text-[13px] text-stage-ink-2">{tab === "evidence" ? loadError : extraError}</p>
            <button type="button" className="mt-3 inline-flex h-7 items-center rounded-md border border-stage-line px-2.5 text-[13px] font-medium text-stage-ink hover:bg-white/10"
              onClick={() => (tab === "evidence" ? setAttempt((n) => n + 1) : setExtraAttempt((n) => n + 1))}>
              Retry
            </button>
          </div>
        ) : shown === "" || (tab === "evidence" && full && !full.image) ? (
          <p className="px-6 text-center text-[13px] text-stage-ink-2">No image is stored for this view.</p>
        ) : (
          <>
            {v.thumbnail && <img src={jpegDataUrl(v.thumbnail)} alt="" className="absolute inset-0 size-full object-contain opacity-40 blur-sm" />}
            <Spinner size={22} className="relative text-stage-ink" />
          </>
        )}
        {!purgedAt && shown && <span className="pointer-events-none absolute bottom-2 left-3 rounded bg-stage/80 px-1.5 py-0.5 text-xs text-stage-ink-2">{TAB_CAPTION[tab]}</span>}
      </div>

      {/* ---- verdict bar */}
      <div className="border-b border-line px-4 py-3">
        {review ? (
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={review.verdict === "valid" ? "ok" : "warn"} icon={review.verdict === "valid" ? "check" : "x"}>
                  {review.verdict === "valid" ? "Valid violation" : VERDICT_LABEL.false_alarm}
                </Tag>
                {review.verdict === "false_alarm" && review.reason && <span className="font-medium text-ink">{reasonLabel(review.reason)}</span>}
              </div>
              {review.note && <p className="mt-1.5 text-ink-2">“{review.note}”</p>}
              <p className="mt-1.5 text-ink-3">
                Reviewed{review.by ? <> by <span className="font-medium text-ink-2">{review.by}</span></> : null}
                {review.at != null && <> on <span className="num">{fmtDateTime(review.at)}</span></>}
              </p>
            </div>
            {canReview && <Button variant="ghost" size="sm" icon="undo" loading={busy === "undo"} onClick={() => void submit(null)}>Undo review</Button>}
          </div>
        ) : !canReview ? (
          <p className="flex items-center gap-2 text-[13px] text-ink-3">
            <Icon name="lock" size={14} className="shrink-0" />
            Not reviewed yet. Your role can view evidence but cannot record verdicts.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Button className="h-11" icon="check" loading={busy === "valid"} disabled={!!busy} onClick={() => void submit("valid")}>
                Valid violation <span className="hidden lg:inline"><Kbd>V</Kbd></span>
              </Button>
              <Button className={cx("h-11", picker && "border-warn bg-warn-soft hover:bg-warn-soft")} icon="x" aria-expanded={picker} disabled={!!busy}
                onClick={() => (picker ? setPicker(false) : openPicker())}>
                False alarm <span className="hidden lg:inline"><Kbd>F</Kbd></span>
              </Button>
            </div>
            {picker && (
              <form onSubmit={saveFalseAlarm} className="animate-rise mt-3 rounded-md border border-line bg-canvas p-3">
                <div className="text-[13px] font-medium text-ink" id={`why-${id}`}>Why was this a false alarm?</div>
                <div role="group" aria-labelledby={`why-${id}`} className="mt-2 flex flex-wrap gap-1.5">
                  {reasons.map((r, i) => (
                    <Chip key={r.id} selected={reason === r.id} onClick={() => setReason(r.id)}>
                      {i < 9 && <span className="num hidden text-[11px] opacity-60 lg:inline">{i + 1}</span>}
                      {r.label}
                    </Chip>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)" aria-label="Note (optional)" className="min-w-40 flex-1" />
                  <Button variant="ghost" onClick={() => setPicker(false)}>Cancel</Button>
                  <Button type="submit" variant="primary" disabled={!reason} loading={busy === "false_alarm"}
                    title={reason ? undefined : "Choose a reason first"}>Save false alarm</Button>
                </div>
                {!reason && <p className="mt-2 text-xs text-ink-3">Choose a reason to save. Reasons are exported with the dataset to help retrain the model.</p>}
              </form>
            )}
          </>
        )}
      </div>

      {/* ---- details */}
      <dl>
        <Row label="Camera">
          {v.stream_name}
          {meta?.camera?.source_type && <span className="text-ink-3"> · {meta.camera.source_type}</span>}
        </Row>
        <Row label="Detected"><span className="num">{fmtDateTime(v.timestamp)}</span></Row>
        <Row label="Duration">
          <span className="num">{fmtDuration(v.duration ?? Math.max(0, (v.last_seen ?? v.timestamp) - v.timestamp))}</span>
          {v.observations !== undefined && <span className="text-ink-3"> · <span className="num">{v.observations}</span> observation{v.observations === 1 ? "" : "s"}</span>}
          {ongoing && <Tag tone="accent" className="ml-2">Ongoing</Tag>}
        </Row>
        <Row label="Track"><span className="num">#{v.track_id}</span></Row>
        {det?.zone && <Row label="Zone">{det.zone}</Row>}
        <Row label="Flagged">
          {det?.items && Object.keys(det.items).length ? (
            <ul className="space-y-1">
              {Object.entries(det.items).map(([k, it]) => (
                <li key={k} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{violationLabel(k)}</span>
                  <span className="text-ink-3">
                    {it.confidence != null
                      ? <><span className="num text-ink-2">{fmtPct(it.confidence, 0)}</span> confidence{/zone/i.test(it.evidence ?? "") ? ` · ${it.evidence}` : ""}</>
                      : /zone/i.test(it.evidence ?? "") ? it.evidence : "not seen (required item absent)"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="flex flex-wrap gap-1">{v.missing.map((m) => <Tag key={m} tone="bad">{violationLabel(m)}</Tag>)}</span>
          )}
        </Row>
        {(personConf != null || v.confidence != null) && (
          <Row label={personConf != null ? "Person confidence" : "Confidence"}>
            <span className="num">{fmtPct(personConf ?? v.confidence, 0)}</span>
            {det?.box_verified_at_full_res && <span className="text-ink-3"> · re-checked at full resolution</span>}
          </Row>
        )}
        <Row label="Lifecycle">
          <ol className="space-y-1">
            <li><span className="inline-block w-24 text-ink-3">Detected</span><span className="num">{fmtTime(life?.detected_at ?? v.timestamp)}</span></li>
            {life?.confirmed_at != null && <li><span className="inline-block w-24 text-ink-3">Confirmed</span><span className="num">{fmtTime(life.confirmed_at)}</span></li>}
            {v.last_seen != null && (
              <li>
                <span className="inline-block w-24 text-ink-3">Last seen</span><span className="num">{fmtTime(v.last_seen)}</span>
                {ongoing && <span className="text-ink-3"> · still in view</span>}
              </li>
            )}
            <li>
              <span className="inline-block w-24 text-ink-3">Acknowledged</span>
              {v.acknowledged_at != null
                ? <><span className="num">{fmtDateTime(v.acknowledged_at)}</span>{v.acknowledged_by && <span className="text-ink-3"> by {v.acknowledged_by}</span>}</>
                : <span className="text-ink-3">not yet</span>}
            </li>
          </ol>
        </Row>
      </dl>
      {meta ? <Provenance meta={meta} /> : full && (
        <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">Recorded before detection provenance was kept, so model and threshold details are not available.</p>
      )}
      {loadError && full === null && (
        <div className="border-t border-line p-4">
          <Notice tone="warn" title="Showing the list entry only" action={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>
            The full record could not be loaded: {loadError}
          </Notice>
        </div>
      )}
      {canDelete && (
        <div className="border-t border-line px-4 py-3">
          <Button variant="ghost" size="sm" icon="trash" className="text-bad hover:text-bad" onClick={() => setConfirmDelete(true)}>Delete violation</Button>
        </div>
      )}
      <ConfirmDialog open={confirmDelete} onClose={() => !deleting && setConfirmDelete(false)} onConfirm={() => void remove()}
        title="Delete this violation?" confirmLabel="Delete violation" danger busy={deleting}>
        The record from {v.stream_name} at <span className="num">{fmtDateTime(v.timestamp)}</span>, its evidence images and any verdict are removed
        permanently. It will no longer count in analytics or dataset exports.
      </ConfirmDialog>
    </>
  );

  if (inDrawer) return body;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{body}</div>
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-canvas px-4 py-2 text-xs text-ink-3">
        <span><Kbd>J</Kbd> <Kbd>K</Kbd> next / previous</span>
        {canReview && <>
          <span><Kbd>V</Kbd> valid</span>
          <span><Kbd>F</Kbd> false alarm</span>
          <span><Kbd>1</Kbd>–<Kbd>9</Kbd> reason, <Kbd>Enter</Kbd> save</span>
          <span><Kbd>Esc</Kbd> cancel</span>
        </>}
      </footer>
    </div>
  );
}
