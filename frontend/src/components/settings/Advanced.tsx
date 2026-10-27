/** Settings > Advanced: the raw YAML file, backups, and reset to defaults. */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { fmtDateTime } from "../../lib/format";
import type { BackupInfo, CameraChanges, ConfigDoc, FieldError } from "../../types";
import { Button, ConfirmDialog, Empty, Notice, Panel, PanelHeader, Skeleton, Tag, Textarea } from "../ui";
import { errorMessage, fmtBytes } from "./shared";

type Check = { valid: boolean; errors: FieldError[]; cameras?: CameraChanges } | { failed: string };

export function YamlPanel({ doc, value, onChange, locked, serverErrors }:
  { doc: ConfigDoc; value: string; onChange: (v: string) => void; locked: boolean; serverErrors: FieldError[] }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setCheck(null), [value]);

  const validate = async () => {
    setBusy(true);
    try {
      setCheck(await api.config.validate({ yaml: value }));
    } catch (e) {
      setCheck({ failed: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const errors = check && "errors" in check && !check.valid ? check.errors : serverErrors;
  const edited = value !== doc.yaml;
  return (
    <Panel>
      <PanelHeader title="Configuration file"
        hint={<>The file the server reads, <span className="num break-all">{doc.path}</span>. Comments are kept. A backup is written before every save.</>}
        actions={<>
          {edited && <Button size="sm" variant="ghost" icon="undo" onClick={() => onChange(doc.yaml)}>Revert</Button>}
          <Button size="sm" icon="check" loading={busy} disabled={locked} onClick={() => void validate()}>Validate YAML</Button>
        </>} />
      <div className="flex flex-col gap-3 p-4">
        {locked && <Notice tone="warn">Save or discard the changes made in the other sections first. The file below does not include them.</Notice>}
        <Textarea aria-label="Configuration file contents" value={value} disabled={locked} invalid={errors.length > 0}
          onChange={(e) => onChange(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
          className="num scroll-thin h-[min(60dvh,560px)] resize-y text-[13px] leading-5 whitespace-pre" />
        {check && "failed" in check && <Notice tone="bad" title="The file could not be checked">{check.failed}</Notice>}
        {check && "valid" in check && check.valid && (
          <Notice tone="ok" title="The file is valid">
            {check.cameras && (check.cameras.removed.length > 0 || check.cameras.added.length > 0 || check.cameras.changed.length > 0)
              ? <>Saving it would {[
                check.cameras.removed.length && `remove ${check.cameras.removed.map((c) => c.name).join(", ")}`,
                check.cameras.added.length && `add ${check.cameras.added.map((c) => c.name).join(", ")}`,
                check.cameras.changed.length && `change ${check.cameras.changed.map((c) => c.name).join(", ")}`,
              ].filter(Boolean).join("; ")}.</>
              : "Saving it does not change any camera."}
          </Notice>
        )}
        {errors.length > 0 && (
          <Notice tone="bad" title={`${errors.length} problem${errors.length === 1 ? "" : "s"} in the file`}>
            <ul className="mt-1 flex flex-col gap-0.5">
              {errors.slice(0, 12).map((e, i) => (
                <li key={i}><span className="num">{e.loc}{e.line ? `, line ${e.line}` : ""}</span>: {e.msg}</li>
              ))}
              {errors.length > 12 && <li>and {errors.length - 12} more</li>}
            </ul>
          </Notice>
        )}
      </div>
    </Panel>
  );
}

export function BackupsPanel({ etag, disabled, onRestore }: { etag: string; disabled: boolean; onRestore: (name: string) => Promise<boolean> }) {
  const [items, setItems] = useState<BackupInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    setItems(null);
    api.config.backups().then(setItems).catch((e) => setError(errorMessage(e)));
  }, []);
  // every save writes a new backup, so the list follows the document version
  useEffect(load, [load, etag]);

  const close = useCallback(() => setPick(null), []);
  const restore = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      await onRestore(pick.name);
    } finally {
      setBusy(false);
      setPick(null);
    }
  };

  return (
    <Panel>
      <PanelHeader title="Backups" hint="A copy of the file is kept before every save, reset and restore. Restoring one replaces the current configuration."
        actions={<Button size="sm" variant="ghost" icon="refresh" onClick={load}>Refresh list</Button>} />
      {error ? (
        <div className="p-4"><Notice tone="bad" title="The backups could not be listed" action={<Button size="sm" onClick={load}>Retry</Button>}>{error}</Notice></div>
      ) : items === null ? (
        <div className="flex flex-col gap-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : items.length === 0 ? (
        <Empty icon="clock" title="No backups yet">The first one is written the next time the configuration is saved.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th scope="col">Saved</th><th scope="col">File</th><th scope="col" className="text-right!">Size</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((b, i) => (
                <tr key={b.name}>
                  <td className="num whitespace-nowrap">{fmtDateTime(b.created)} {i === 0 && <Tag>newest</Tag>}</td>
                  <td className="num text-ink-3">{b.name}</td>
                  <td className="num text-right whitespace-nowrap">{fmtBytes(b.size)}</td>
                  <td className="text-right"><Button size="sm" icon="undo" disabled={disabled} onClick={() => setPick(b)}>Restore</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog open={!!pick} onClose={close} onConfirm={() => void restore()} busy={busy}
        title="Restore this backup?" confirmLabel="Restore backup">
        {pick && <>
          The configuration saved on <span className="num text-ink">{fmtDateTime(pick.created)}</span> replaces the current one and is applied
          straight away. Cameras whose settings differ restart. The current file is backed up first, so this can be undone.
        </>}
      </ConfirmDialog>
    </Panel>
  );
}

export function ResetPanel({ cameraCount, disabled, onReset }: { cameraCount: number; disabled: boolean; onReset: (keepCameras: boolean) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => { setOpen(false); setKeep(true); }, []);

  const reset = async () => {
    setBusy(true);
    try {
      await onReset(keep);
    } finally {
      setBusy(false);
      close();
    }
  };

  return (
    <Panel>
      <PanelHeader title="Reset to defaults" className="border-b-0!"
        hint="Puts every setting on this page back to the values the system shipped with. The current file is backed up first."
        actions={<Button size="sm" icon="undo" disabled={disabled} onClick={() => setOpen(true)}>Reset settings</Button>} />
      <ConfirmDialog open={open} onClose={close} onConfirm={() => void reset()} busy={busy} danger
        title="Reset settings to defaults?" confirmLabel={keep ? "Reset settings" : "Reset and remove cameras"}>
        <p>Model, performance, tracking, compliance, alert, alarm and server settings return to their defaults and are applied straight away.</p>
        <label className="mt-3 flex items-start gap-2 text-ink">
          <input type="checkbox" className="mt-0.5 size-4 accent-(--color-accent)" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span>
            Keep cameras
            <span className="block text-xs text-ink-3">
              {keep
                ? `The ${cameraCount} configured camera${cameraCount === 1 ? "" : "s"}, with their rules and zones, stay as they are.`
                : "All cameras are removed too. You will be asked to confirm the list."}
            </span>
          </span>
        </label>
      </ConfirmDialog>
    </Panel>
  );
}
