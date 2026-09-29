import { useEffect, useState } from "react";
import { api, jpegDataUrl } from "../../lib/api";
import { fmtDateTime, fmtTime, ppeLabel } from "../../lib/format";
import { useAuth } from "../../state/auth";
import type { Violation } from "../../types";
import { Badge, Button, ConfirmModal, Icon, IconButton, Modal, PpeChip, Skeleton, useToast } from "../ui";

interface Props {
  items: Violation[];
  index: number;
  hasMore: boolean;
  onIndex: (i: number) => void;
  onClose: () => void;
  onLoadMore: () => Promise<void>;
  onDeleted: (id: number) => void;
  onChanged: (v: Violation) => void;
}

type Kind = "image" | "crop" | "original";
const KIND_LABEL: Record<Kind, string> = { image: "Evidence", crop: "Person crop", original: "Original frame" };

const cache = new Map<number, Violation>(); // id -> detail (evidence image + metadata), per session
const extraCache = new Map<string, string>(); // `${id}:crop|original` -> base64

const fmtDuration = (s: number) => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
const pct = (c: number | null | undefined) => (c == null ? "—" : `${Math.round(c * 100)}%`);

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs font-medium text-muted uppercase">{label}</dt><dd className="mt-0.5">{children}</dd></div>;
}

/** Full-size violation viewer: evidence images, lifecycle, provenance, prev/next, keyboard (Esc, ←, →), download, delete. */
export function ViolationModal({ items, index, hasMore, onIndex, onClose, onLoadMore, onDeleted, onChanged }: Props) {
  const toast = useToast();
  const { can } = useAuth();
  const [acking, setAcking] = useState(false);
  const v = items[index];
  const [detail, setDetail] = useState<Violation | null>(v ? cache.get(v.id) ?? null : null);
  const [kind, setKind] = useState<Kind>("image");
  const [extra, setExtra] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!v) return;
    let alive = true;
    setError(null);
    setKind("image");
    const hit = cache.get(v.id);
    setDetail(hit ?? null);
    if (!hit) {
      api.violations.get(v.id)
        .then((full) => {
          cache.set(v.id, full);
          if (alive) setDetail(full);
        })
        .catch((e) => alive && setError((e as Error).message));
    }
    // prefetch the neighbours so arrowing through feels instant
    for (const n of [items[index + 1], items[index - 1]]) {
      if (n && !cache.has(n.id)) api.violations.get(n.id).then((f) => cache.set(n.id, f)).catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [v?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // the person crop / original frame are large: fetched only when their tab is opened
  useEffect(() => {
    if (!v || kind === "image") { setExtra(null); return; }
    const key = `${v.id}:${kind}`;
    const hit = extraCache.get(key);
    setExtra(hit ?? null);
    if (hit) return;
    let alive = true;
    api.violations.get(v.id, [kind])
      .then((full) => {
        const b64 = (kind === "crop" ? full.crop : full.original) ?? "";
        extraCache.set(key, b64);
        if (alive) setExtra(b64);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [v?.id, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!v) return null;
  const canPrev = index > 0;
  const canNext = index < items.length - 1 || hasMore;
  const prev = () => canPrev && onIndex(index - 1);
  const next = async () => {
    if (index < items.length - 1) onIndex(index + 1);
    else if (hasMore) {
      await onLoadMore();
      onIndex(index + 1);
    }
  };

  const del = async () => {
    setDeleting(true);
    try {
      await api.violations.remove(v.id);
      cache.delete(v.id);
      toast({ tone: "success", title: "Violation deleted", message: `#${v.id} · ${v.stream_name}` });
      setConfirm(false);
      onDeleted(v.id);
    } catch (e) {
      toast({ tone: "error", title: "Could not delete", message: (e as Error).message });
    } finally {
      setDeleting(false);
    }
  };

  const ack = async () => {
    setAcking(true);
    try {
      onChanged(await api.violations.ack(v.id));
      toast({ tone: "success", title: "Violation acknowledged", message: `#${v.id} · ${v.stream_name}` });
    } catch (e) {
      toast({ tone: "error", title: "Could not acknowledge", message: (e as Error).message });
    } finally {
      setAcking(false);
    }
  };

  const meta = detail?.meta ?? null;
  const purged = v.evidence_purged_at != null;
  const kinds: Kind[] = ["image", ...(detail?.has_crop ? ["crop" as Kind] : []), ...(detail?.has_original ? ["original" as Kind] : [])];
  // evidence image; after evidence retention removed it, the kept thumbnail stands in
  const shown = kind === "image" ? (detail ? (detail.image || (purged ? v.thumbnail : "")) : null) : extra;
  const ongoing = v.state === "ongoing";
  const items_ = meta?.detection?.items ?? {};
  const s = meta?.settings;

  return (
    <>
      <Modal
        open
        size="lg"
        onClose={onClose}
        title={`${v.stream_name} · Worker #${v.track_id}`}
        subtitle={<span className="tabular-nums">{fmtDateTime(v.timestamp)} · violation #{v.id} · {index + 1} of {items.length}{hasMore ? "+" : ""}</span>}
        onKeyDown={(e) => {
          if (confirm) return;
          if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
          if (e.key === "ArrowRight") { e.preventDefault(); next(); }
        }}
        footer={
          <>
            {can("violations:delete") && <Button variant="danger-ghost" icon={<Icon.trash size={15} />} onClick={() => setConfirm(true)}>Delete</Button>}
            <span className="mr-auto" />
            {can("violations:ack") && v.acknowledged_at == null && (
              <Button icon={<Icon.check size={15} />} loading={acking} onClick={ack}>Acknowledge</Button>
            )}
            {shown ? (
              <a href={jpegDataUrl(shown)} download={`violation-${v.id}-${v.stream_id}${kind === "image" ? "" : `-${kind}`}.jpg`}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-transparent bg-primary px-3.5 text-sm font-medium text-on-primary shadow-sm hover:bg-primary-hover">
                <Icon.download size={15} /> Download
              </a>
            ) : (
              <Button variant="primary" icon={<Icon.download size={15} />} disabled>Download</Button>
            )}
          </>
        }
      >
        <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_240px]">
          <div className="flex min-w-0 flex-col gap-2">
            {kinds.length > 1 && (
              <div className="inline-flex self-start rounded-lg border border-border bg-subtle p-0.5" role="group" aria-label="Evidence image">
                {kinds.map((k) => (
                  <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
                    className={`h-7 rounded-md px-2.5 text-[13px] font-medium ${kind === k ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"}`}>{KIND_LABEL[k]}</button>
                ))}
              </div>
            )}
            <div className="relative flex min-h-[320px] items-center justify-center overflow-hidden rounded-lg bg-video">
              {error ? (
                <p className="px-6 text-center text-sm text-slate-300">Couldn't load the image: {error}</p>
              ) : shown === null ? (
                <Skeleton className="absolute inset-0 rounded-none bg-slate-700/60" />
              ) : shown === "" ? (
                <p className="px-6 text-center text-sm text-slate-300">No image stored.</p>
              ) : (
                <img src={jpegDataUrl(shown)} alt={`Violation ${v.id}: ${v.stream_name}, worker ${v.track_id} (${KIND_LABEL[kind].toLowerCase()})`} className="max-h-[62vh] w-full object-contain" />
              )}
              <IconButton label="Previous (←)" variant="secondary" onClick={prev} disabled={!canPrev} className="absolute top-1/2 left-3 -translate-y-1/2 bg-white/90">
                <Icon.chevronLeft size={18} />
              </IconButton>
              <IconButton label="Next (→)" variant="secondary" onClick={next} disabled={!canNext} className="absolute top-1/2 right-3 -translate-y-1/2 bg-white/90">
                <Icon.chevronRight size={18} />
              </IconButton>
            </div>
            {purged && <p className="text-xs text-muted">Evidence images were removed by the evidence-retention policy on {fmtDateTime(v.evidence_purged_at!)}; the record and its thumbnail are kept.</p>}
          </div>
          <dl className="flex flex-col gap-3.5 text-sm">
            <Row label="Camera"><span className="font-medium">{v.stream_name} <span className="font-mono text-xs text-muted">({v.stream_id})</span></span></Row>
            <Row label="Violations">
              <span className="mt-1 flex flex-col gap-1.5">
                {v.missing.map((m) => (
                  <span key={m} className="flex items-center gap-2">
                    <PpeChip item={m} status="missing" />
                    {meta && <span className="font-mono text-xs text-muted" title={items_[m]?.evidence ?? "recorded later in the event"}>
                      {items_[m] ? (items_[m].confidence != null ? pct(items_[m].confidence) : "not seen") : "added later"}</span>}
                  </span>
                ))}
              </span>
            </Row>
            <Row label="Lifecycle">
              <ol className="mt-1 flex flex-col gap-1 text-[13px] tabular-nums">
                <li><span className="text-muted">Detected</span> {fmtTime(v.timestamp)}</li>
                {meta?.lifecycle && <li><span className="text-muted">Confirmed</span> {fmtTime(meta.lifecycle.confirmed_at)}</li>}
                <li>{ongoing
                  ? <><Badge tone="danger" dot pulse>Ongoing</Badge> <span className="text-muted">last seen {fmtTime(v.last_seen ?? v.timestamp)}</span></>
                  : <><span className="text-muted">Ended</span> {fmtTime(v.last_seen ?? v.timestamp)}</>}
                  {(v.duration ?? 0) > 0 && <span className="block text-xs text-muted">{fmtDuration(v.duration ?? 0)} · {v.observations} observation{v.observations === 1 ? "" : "s"}</span>}
                </li>
                <li>{v.acknowledged_at != null
                  ? <span className="font-medium text-success-text">Acknowledged by {v.acknowledged_by}<span className="block text-xs font-normal text-muted">{fmtDateTime(v.acknowledged_at)}</span></span>
                  : <span className="font-medium text-warning-text">Not acknowledged</span>}</li>
              </ol>
            </Row>
            <Row label="Track ID"><span className="font-mono font-medium">#{v.track_id}</span></Row>
            {meta && (
              <details className="rounded-md border border-border p-2 text-xs">
                <summary className="cursor-pointer font-medium text-text">How this was detected</summary>
                <dl className="mt-2 flex flex-col gap-1.5 text-muted">
                  {meta.model && <div><dt className="font-medium text-text">Model</dt><dd className="font-mono break-all">{meta.model.weights} · sha256 {meta.model.sha256}{meta.model.device ? ` · ${meta.model.device} @ ${meta.model.imgsz}px` : ""}{meta.model.phone_model?.weights ? ` · phone: ${meta.model.phone_model.weights}` : ""}</dd></div>}
                  {meta.detection && <div><dt className="font-medium text-text">Detection</dt><dd>person {pct(meta.detection.person_confidence)}{meta.detection.box_verified_at_full_res != null ? ` · box ${meta.detection.box_verified_at_full_res ? "verified" : "not verified"} at full resolution` : ""}{meta.detection.evidence_frame_score != null ? ` · best-frame score ${meta.detection.evidence_frame_score}` : ""}</dd></div>}
                  {s && <div><dt className="font-medium text-text">Rules at the time</dt><dd>threshold {String(s.confidence_threshold)} · confirm {String(s.min_violation_frames)} frames / {String(s.min_violation_seconds)} s · event gap {String(s.event_gap_seconds)} s · {String(s.missing_policy)} policy{s.not_checked?.length ? ` · not checked: ${s.not_checked.map(ppeLabel).join(", ")}` : ""}</dd></div>}
                  {s?.config_sha256 && <div><dt className="font-medium text-text">Config</dt><dd className="font-mono">sha256 {s.config_sha256}</dd></div>}
                  {meta.evidence && <div><dt className="font-medium text-text">Evidence integrity</dt><dd className="font-mono break-all">{Object.entries(meta.evidence.sha256).filter(([, h]) => h).map(([k, h]) => `${k} ${h!.slice(0, 12)}…`).join(" · ")}</dd></div>}
                </dl>
              </details>
            )}
            <p className="mt-auto text-xs text-muted">Use ← → to browse, Esc to close.</p>
          </dl>
        </div>
      </Modal>
      <ConfirmModal open={confirm} danger busy={deleting} title="Delete this violation?" confirmLabel="Delete"
        message={ongoing ? "The record and its evidence are removed permanently. The event is still ongoing: it won't be recorded again unless the worker is compliant or gone first."
          : "The record and its evidence are removed permanently."} onConfirm={del} onCancel={() => setConfirm(false)} />
    </>
  );
}
