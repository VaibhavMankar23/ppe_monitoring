/** Where a camera gets its video: the fields for the chosen source type, upload, and a connection test. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, jpegDataUrl } from "../../lib/api";
import { fieldMeta } from "../../lib/configForm";
import type { ConfigSchema, RawConfig, ServerFiles, SourceTestResult } from "../../types";
import { errorMessage, fmtBytes } from "../settings/shared";
import { Button, Field, Input, Notice, Select, Spinner, Switch } from "../ui";

/** What the server sends in place of a stored (encrypted) camera password. Sent back, it means "unchanged". */
export const PASSWORD_MASK = "********";

const TYPE_LABEL: Record<string, string> = {
  rtsp: "IP camera (RTSP)",
  http: "IP camera (HTTP)",
  file: "Video file on the server",
  images: "Folder of images on the server",
  webcam: "USB webcam on the server",
  onvif: "ONVIF (not supported yet)",
};

const isNetwork = (t: string) => t === "rtsp" || t === "http";

/** Source in one line with nothing secret in it: no credentials, no query string. */
export function sourceSummary(source: RawConfig | undefined): string {
  const uri = String(source?.uri ?? "").trim();
  if (!uri) return "Not set";
  const type = source?.type ?? "file";
  if (type === "webcam") return `Device ${uri}`;
  if (isNetwork(type)) {
    const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#]*@)?([^/?#]*)([^?#]*)/i.exec(uri);
    return m ? `${m[2]}${m[3]}` : uri.replace(/\/\/[^/?#]*@/, "//").split("?")[0];
  }
  return uri.split(/[\\/]/).filter(Boolean).pop() ?? uri;
}

interface Props {
  source: RawConfig;
  onChange: (s: RawConfig) => void;
  /** the saved camera has a password on the server */
  hasStoredPassword: boolean;
  /** id of the saved camera, so a test can use its stored password */
  streamId?: string;
  disabled: boolean;
  canUpload: boolean;
  schema: ConfigSchema;
  /** field errors relative to the source ("uri", "timeout", ...) */
  errors: Record<string, string>;
}

export function SourceForm({ source, onChange, hasStoredPassword, streamId, disabled, canUpload, schema, errors }: Props) {
  const type: string = source.type ?? "file";
  const uri: string = source.uri ?? "";
  const types = schema.source_types.includes(type) ? schema.source_types : [type, ...schema.source_types];
  const meta = (k: string) => fieldMeta(schema.schema, `streams.0.source.${k}`);

  const set = (key: string, value: unknown) => {
    const next = { ...source };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const setNumber = (key: string, text: string) => set(key, text === "" ? undefined : Number.isNaN(Number(text)) ? text : Number(text));
  const setType = (t: string) => {
    const next: RawConfig = { ...source, type: t, uri: "" };
    if (!isNetwork(t)) { delete next.username; delete next.password; }
    onChange(next);
  };

  // ---------------------------------------------------------------- server files
  const needsFiles = type === "file" || type === "images";
  const [files, setFiles] = useState<ServerFiles | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const loadFiles = useCallback(() => {
    setFilesError(null);
    api.sources.files().then(setFiles).catch((e) => setFilesError(errorMessage(e)));
  }, []);
  useEffect(() => { if (needsFiles && !disabled && !files) loadFiles(); }, [needsFiles, disabled, files, loadFiles]);

  const fileInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const latest = useRef({ source, onChange });
  latest.current = { source, onChange };
  const doUpload = async (file: File) => {
    setUploadError(null);
    setUpload({ name: file.name, pct: 0 });
    try {
      const r = await api.sources.upload(file, (pct) => setUpload({ name: file.name, pct }));
      latest.current.onChange({ ...latest.current.source, type: "file", uri: r.uri });
      loadFiles();
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setUpload(null);
    }
  };

  // ---------------------------------------------------------------- connection test
  const key = JSON.stringify(source);
  const [test, setTest] = useState<{ key: string; result: SourceTestResult } | null>(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    let result: SourceTestResult;
    try {
      result = await api.sources.test(source, streamId);
    } catch (e) {
      result = { ok: false, source: "", type, message: errorMessage(e) };
    }
    setTest({ key, result });
    setTesting(false);
  };
  const result = test?.key === key ? test.result : null;

  // ---------------------------------------------------------------- password
  const password: string = source.password ?? "";
  const stored = password === PASSWORD_MASK;

  const list = type === "images" ? files?.image_folders ?? [] : files?.files ?? [];
  const listed = list.some((f) => f.uri === uri);

  return (
    <div className="flex flex-col gap-4">
      <Field label="Source type" hint="Changing the type clears the address below." error={errors.type}>
        {(id) => (
          <Select id={id} value={type} disabled={disabled} onChange={(e) => setType(e.target.value)} className="sm:max-w-xs">
            {types.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}
          </Select>
        )}
      </Field>

      {isNetwork(type) && (
        <>
          <Field label={type === "rtsp" ? "RTSP URL" : "Stream or snapshot URL"} error={errors.uri}
            hint={type === "rtsp"
              ? "Without the password: put it in the field below, where it is stored encrypted."
              : "An MJPEG stream, a JPEG snapshot URL (polled), or HLS / MP4 over HTTP. Leave the password out of the URL."}>
            {(id) => <Input id={id} className="num" value={uri} disabled={disabled} invalid={!!errors.uri} spellCheck={false} autoComplete="off"
              placeholder={type === "rtsp" ? "rtsp://192.168.1.64:554/Streaming/Channels/101" : "http://192.168.1.70/video.mjpg"}
              onChange={(e) => set("uri", e.target.value)} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username" optional error={errors.username}>
              {(id) => <Input id={id} value={source.username ?? ""} disabled={disabled} autoComplete="off" spellCheck={false}
                onChange={(e) => set("username", e.target.value || undefined)} />}
            </Field>
            <Field label="Password" optional error={errors.password}
              hint={stored ? "A password is stored encrypted and is not shown. Type to replace it."
                : password ? "Encrypted when the camera is saved, and never shown again." : hasStoredPassword ? "The stored password will be removed when you save." : "Stored encrypted on the server."}>
              {(id) => (
                <div className="flex gap-2">
                  <Input id={id} type="password" autoComplete="new-password" disabled={disabled} invalid={!!errors.password}
                    value={stored ? "" : password} placeholder={stored ? "Stored" : "Not set"}
                    onChange={(e) => set("password", e.target.value || (hasStoredPassword ? PASSWORD_MASK : undefined))} />
                  {stored && <Button variant="ghost" disabled={disabled} onClick={() => set("password", undefined)}>Remove</Button>}
                  {!stored && !password && hasStoredPassword && <Button variant="ghost" disabled={disabled} onClick={() => set("password", PASSWORD_MASK)}>Keep stored</Button>}
                </div>
              )}
            </Field>
            <Field label={<>Timeout <span className="font-normal text-ink-3">s</span></>} error={errors.timeout}
              hint="With no picture for this long the camera is treated as down and reconnects.">
              {(id) => <Input id={id} type="number" className="num" min={1} max={meta("timeout").maximum} step={1} disabled={disabled} invalid={!!errors.timeout}
                value={source.timeout ?? ""} placeholder={String(meta("timeout").default ?? 10)} onChange={(e) => setNumber("timeout", e.target.value)} />}
            </Field>
            {type === "http" && (
              <Field label={<>Snapshot polls <span className="font-normal text-ink-3">per second</span></>} optional error={errors.fps}
                hint="Only for snapshot URLs: how often the picture is fetched.">
                {(id) => <Input id={id} type="number" className="num" min={0} max={30} step={1} disabled={disabled} invalid={!!errors.fps}
                  value={source.fps || ""} placeholder="5" onChange={(e) => setNumber("fps", e.target.value)} />}
              </Field>
            )}
          </div>
        </>
      )}

      {type === "webcam" && (
        <Field label="Device index" error={errors.uri} hint="0 is the first camera plugged into the server, 1 the second.">
          {(id) => <Input id={id} className="num sm:max-w-32" inputMode="numeric" value={uri} disabled={disabled} invalid={!!errors.uri} placeholder="0"
            onChange={(e) => set("uri", e.target.value)} />}
        </Field>
      )}

      {needsFiles && (
        <>
          <Field label={type === "images" ? "Image folder" : "Video file"} error={errors.uri}
            hint={filesError ? undefined : files
              ? <>Listed from <span className="num break-all">{files.dir}</span> on the server.</>
              : disabled ? undefined : "Loading the server's video folder."}>
            {(id) => (
              <Select id={id} value={uri} disabled={disabled} invalid={!!errors.uri} onChange={(e) => set("uri", e.target.value)}>
                <option value="">{list.length || !files ? "Choose" : type === "images" ? "No image folders on the server" : "No videos on the server"}</option>
                {uri && !listed && <option value={uri}>{uri}</option>}
                {list.map((f) => <option key={f.uri} value={f.uri}>{f.name}{"size" in f ? ` (${fmtBytes(f.size)})` : ""}</option>)}
              </Select>
            )}
          </Field>
          {filesError && <Notice tone="bad" title="The server's files could not be listed" action={<Button size="sm" onClick={loadFiles}>Retry</Button>}>{filesError}</Notice>}

          {type === "file" && (
            <div className="rounded-md border border-dashed border-line-strong px-3 py-2.5">
              <input ref={fileInput} type="file" hidden accept={["video/*", ...(files?.extensions ?? [])].join(",")}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void doUpload(f); }} />
              {upload ? (
                <div role="status">
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="min-w-0 truncate">Uploading {upload.name}</span><span className="num shrink-0">{upload.pct}%</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={upload.pct}>
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${upload.pct}%` }} />
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button size="sm" icon="upload" disabled={disabled || !canUpload} onClick={() => fileInput.current?.click()}>Upload video</Button>
                  <span className="min-w-0 flex-1 text-xs text-ink-3">
                    {canUpload
                      ? <>Send a recording from this computer. It plays in a loop like a live camera.{files ? ` Up to ${files.max_upload_mb} MB.` : ""}</>
                      : "Uploading a video needs a Super Admin. You can pick one already on the server."}
                  </span>
                </div>
              )}
              {uploadError && <p role="alert" className="mt-1.5 text-xs text-bad">{uploadError}</p>}
            </div>
          )}

          <Field label={type === "images" ? "Folder path" : "File path"} optional
            hint="For a path outside the list. Relative paths start from the configuration file; ${PPE_VIDEOS_DIR} is allowed.">
            {(id) => <Input id={id} className="num" value={uri} disabled={disabled} spellCheck={false} placeholder={type === "images" ? "../data/cam5" : "../videos/cam1.mp4"}
              onChange={(e) => set("uri", e.target.value)} />}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={<>Playback rate <span className="font-normal text-ink-3">fps</span></>} optional error={errors.fps}
              hint={type === "images" ? "Empty plays 5 images per second." : "Empty uses the file's own rate. Raw NVR exports have none: set it, for example 20."}>
              {(id) => <Input id={id} type="number" className="num" min={0} max={meta("fps").maximum ?? 120} step={1} disabled={disabled} invalid={!!errors.fps}
                value={source.fps || ""} placeholder="Auto" onChange={(e) => setNumber("fps", e.target.value)} />}
            </Field>
            <div className="sm:pt-6">
              <Switch checked={source.loop ?? true} disabled={disabled} onChange={(v) => set("loop", v)} label="Loop"
                hint="Start again at the end. Off: the camera stops when the recording finishes." />
            </div>
          </div>
        </>
      )}

      {type === "onvif" && <Notice tone="warn">ONVIF discovery is not supported yet. Use the camera's RTSP URL with the RTSP type.</Notice>}

      <div className="border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button icon="pulse" loading={testing} disabled={disabled || !uri.trim() || !!upload} onClick={() => void runTest()}>Test connection</Button>
          <span className="min-w-0 flex-1 text-xs text-ink-3">
            {testing
              ? "Opening the source from the server and waiting for a picture. A network camera can take up to 20 seconds."
              : "Opens the source from the server itself, which is what matters: address, sign-in and video format are all checked."}
          </span>
        </div>
        {testing && <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-3"><Spinner size={14} /> Connecting</div>}
        {result && (result.ok ? (
          <div className="mt-3 flex flex-wrap gap-3 rounded-md bg-ok-soft p-2.5" role="status">
            {result.thumbnail && <img src={jpegDataUrl(result.thumbnail)} alt="First picture from the source" className="h-24 w-auto rounded bg-stage" />}
            <div className="min-w-0 text-[13px]">
              <p className="font-semibold text-ok">Connected</p>
              {result.message && <p className="break-words text-ink">{result.message}</p>}
              <dl className="num mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-ink-2">
                {!!result.width && !!result.height && <><dt>Resolution</dt><dd>{result.width} × {result.height}</dd></>}
                {!!result.fps && <><dt>Frame rate</dt><dd>{Math.round(result.fps * 10) / 10} fps</dd></>}
                {result.open_ms != null && <><dt>Time to open</dt><dd>{Math.round(result.open_ms)} ms</dd></>}
                {result.total_ms != null && <><dt>First picture</dt><dd>{Math.round(result.total_ms)} ms</dd></>}
              </dl>
            </div>
          </div>
        ) : (
          <Notice tone="bad" className="mt-3" title="No video from this source">
            <span className="break-words">{result.message || "The server could not open it."}</span>
          </Notice>
        ))}
      </div>
    </div>
  );
}
