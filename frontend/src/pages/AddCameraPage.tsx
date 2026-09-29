import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PageBody } from "../components/layout/PageBody";
import { Topbar } from "../components/layout/Topbar";
import { SourceTester } from "../components/config/SourceTester";
import { Advisory, Button, Card, EmptyState, Field, Icon, Input, Select, Skeleton, Toggle, UnenforcedNote, useToast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { isChecked, phoneProblem } from "../lib/capabilities";
import { ppeLabel } from "../lib/format";
import { navigate } from "../lib/router";
import { useAuth } from "../state/auth";
import type { Capabilities, ConfigDoc, RawConfig, ServerFiles, SourceTestResult } from "../types";

type Kind = "rtsp" | "http" | "server_file" | "upload" | "webcam" | "images";

const KINDS: { id: Kind; title: string; text: string; icon: ReactNode }[] = [
  { id: "rtsp", title: "IP camera (RTSP)", text: "Most CCTV / NVR cameras: rtsp://address:554/stream", icon: <Icon.camera size={20} /> },
  { id: "http", title: "IP camera (HTTP)", text: "MJPEG stream or snapshot URL, e.g. http://address/video.mjpg", icon: <Icon.server size={20} /> },
  { id: "upload", title: "Upload a video file", text: "Send a recording from this computer; it plays in a loop like a live camera", icon: <Icon.upload size={20} /> },
  { id: "server_file", title: "Video already on the server", text: "Pick a recording in the server's videos folder (e.g. NVR exports)", icon: <Icon.file size={20} /> },
  { id: "webcam", title: "USB webcam", text: "A camera plugged into the server itself", icon: <Icon.camera size={20} /> },
  { id: "images", title: "Folder of images", text: "Stills played in name order", icon: <Icon.image size={20} /> },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "cam";
const fmtSize = (b: number) => (b > 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.round(b / 2 ** 20)} MB`);

/** Full-page camera wizard: pick a source, fill in the details, test, then save — which starts the
 * camera and opens it live on the dashboard. Replaces the old modal so adding a camera is its own page. */
export function AddCameraPage() {
  const { can } = useAuth();
  const canUpload = can("config:system");
  const toast = useToast();

  const [doc, setDoc] = useState<ConfigDoc | null>(null);
  const [ppeItems, setPpeItems] = useState<string[]>(["helmet", "vest"]);
  const [caps, setCaps] = useState<Capabilities | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState("");
  const [uri, setUri] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fps, setFps] = useState("");
  const [ppe, setPpe] = useState<string[]>(["helmet", "vest"]);
  const [priority, setPriority] = useState("normal");
  const [detectPhone, setDetectPhone] = useState(false);
  const [files, setFiles] = useState<ServerFiles | null>(null);
  const [upload, setUpload] = useState<{ pct: number; name: string } | null>(null);
  const [tested, setTested] = useState<SourceTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoadError(null);
    Promise.all([api.config.get(), api.config.schema()])
      .then(([d, s]) => { setDoc(d); setPpeItems(s.ppe_items ?? ["helmet", "vest"]); setCaps(s.capabilities); })
      .catch((e) => setLoadError((e as Error).message));
  };
  useEffect(load, []);
  useEffect(() => { setTested(null); }, [uri, username, password, kind]);
  useEffect(() => {
    if ((kind === "server_file" || kind === "images") && !files) api.sources.files().then(setFiles).catch((e) => setError((e as Error).message));
  }, [kind, files]);

  // Per-camera phone detection only has an effect once a phone model is configured globally.
  const phoneWarning = phoneProblem(doc?.config.model?.phone_weights, caps);
  const existingIds = useMemo(() => (doc?.config.streams ?? []).map((s: { id: string }) => s.id), [doc]);
  const id = useMemo(() => {
    const base = slug(name || (kind ?? "cam"));
    let c = base, n = 2;
    while (existingIds.includes(c)) c = `${base}-${n++}`;
    return c;
  }, [name, kind, existingIds]);

  const sourceType = kind === "server_file" || kind === "upload" ? "file" : kind;
  const source: RawConfig | undefined = kind ? {
    type: sourceType, uri: uri.trim(),
    ...(kind === "rtsp" || kind === "http" ? { username: username.trim() || undefined, password: password || undefined } : {}),
    ...(fps && (sourceType === "file" || sourceType === "images" || kind === "http") ? { fps: Number(fps) } : {}),
  } : undefined;

  const doUpload = async (file: File) => {
    setError(null);
    setUpload({ pct: 0, name: file.name });
    try {
      const r = await api.sources.upload(file, (pct) => setUpload({ pct, name: file.name }));
      setUri(r.uri);
      if (!name) setName(file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 40));
      setUpload({ pct: 100, name: r.name });
    } catch (e) {
      setError((e as Error).message);
      setUpload(null);
    }
  };

  const submit = async () => {
    if (!doc || !source || !uri.trim() || !name.trim()) return;
    if (tested && !tested.ok && !window.confirm("The connection test failed. Add the camera anyway? It will keep retrying in the background.")) return;
    setBusy(true);
    setError(null);
    const stream = { id, name: name.trim(), source: Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== "")), required_ppe: ppe, enabled: true, priority, ...(detectPhone ? { detect_phone: true } : {}) };
    try {
      const next = { ...doc.config, streams: [...(doc.config.streams ?? []), stream] };
      await api.config.save({ config: next, etag: doc.etag });
      toast({ tone: "success", title: `Camera "${stream.name}" added`, message: "Opening it live on the dashboard…" });
      // land on the dashboard with the new camera's detail view open
      location.hash = `#/dashboard?focus=${encodeURIComponent(id)}`;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  const uriField = kind === "rtsp" ? { label: "RTSP URL", placeholder: "rtsp://192.168.1.64:554/Streaming/Channels/101", hint: "Don't put the password in the URL: use the fields below (stored encrypted)." }
    : kind === "http" ? { label: "Stream or snapshot URL", placeholder: "http://192.168.1.70/video.mjpg", hint: "MJPEG push, a JPEG snapshot URL (polled), or HLS / MP4 over HTTP." }
      : kind === "webcam" ? { label: "Camera index", placeholder: "0", hint: "0 = the first camera on the server." } : null;

  const cancel = () => { if (window.history.length > 1) window.history.back(); else navigate("dashboard"); };

  return (
    <>
      <Topbar title="Add camera" subtitle={kind ? KINDS.find((k) => k.id === kind)?.title : "Choose a source type, then fill in the details"}
        extra={<Button variant="ghost" icon={<Icon.close size={15} />} onClick={cancel}>Cancel</Button>} />
      <PageBody>
        {loadError ? (
          <Card className="mx-auto max-w-3xl"><EmptyState icon={<Icon.alert size={20} />} title="Couldn't load the configuration" message={loadError} action={<Button onClick={load}>Try again</Button>} /></Card>
        ) : !doc ? (
          <Card className="mx-auto max-w-3xl p-6"><Skeleton className="mb-4 h-5 w-40" /><div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div></Card>
        ) : (
          <Card className="mx-auto max-w-3xl">
            <div className="flex flex-col gap-4 px-5 py-5">
              {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger">{error}</p>}
              {!kind ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {KINDS.filter((k) => k.id !== "upload" || canUpload).map((k) => (
                    <button key={k.id} type="button" onClick={() => setKind(k.id)}
                      className="flex min-w-0 gap-3 rounded-xl border border-border p-4 text-left transition hover:border-primary hover:bg-primary-soft/40 focus-visible:border-primary">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-subtle text-primary">{k.icon}</span>
                      <span className="min-w-0"><span className="block text-sm font-semibold">{k.title}</span><span className="mt-0.5 block text-[13px] [overflow-wrap:anywhere] text-muted">{k.text}</span></span>
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field id="ac-name" label="Display name" hint={`Camera ID: ${id} (fixed once saved)`}>
                      <Input id="ac-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Gate 2, loading bay" maxLength={64} />
                    </Field>
                    <Field id="ac-priority" label="Priority" hint="Used when the model is too busy for every camera">
                      <Select id="ac-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
                        <option value="high">High: served first</option>
                        <option value="normal">Normal</option>
                        <option value="low">Low: a third of the detection rate</option>
                      </Select>
                    </Field>
                  </div>

                  {uriField && (
                    <Field id="ac-uri" label={uriField.label} hint={uriField.hint}>
                      <Input id="ac-uri" value={uri} onChange={(e) => setUri(e.target.value)} placeholder={uriField.placeholder} spellCheck={false} className="font-mono" />
                    </Field>
                  )}
                  {(kind === "rtsp" || kind === "http") && (
                    <div className="grid gap-4 md:grid-cols-3">
                      <Field id="ac-user" label="Username"><Input id="ac-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></Field>
                      <Field id="ac-pass" label="Password" hint="Encrypted on the server; never shown again"><Input id="ac-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
                      {kind === "http" && <Field id="ac-fps" label="Snapshot polls / s" hint="Only for snapshot URLs"><Input id="ac-fps" type="number" min={0} max={30} value={fps} onChange={(e) => setFps(e.target.value)} placeholder="5" /></Field>}
                    </div>
                  )}
                  {kind === "upload" && (
                    <div className="rounded-xl border border-dashed border-border-strong p-4 text-center"
                      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void doUpload(f); }}>
                      <input ref={fileInput} type="file" hidden accept="video/*,.cpv,.h264,.h265,.264,.265,.ts" onChange={(e) => { const f = e.target.files?.[0]; if (f) void doUpload(f); }} />
                      {upload ? (
                        <div className="flex flex-col gap-2">
                          <p className="text-[13px]"><b>{upload.name}</b> {upload.pct < 100 ? `uploading… ${upload.pct}%` : "uploaded"}</p>
                          <div className="h-2 overflow-hidden rounded-full bg-subtle"><div className="h-full bg-primary transition-all" style={{ width: `${upload.pct}%` }} /></div>
                        </div>
                      ) : (
                        <>
                          <p className="text-[13px] text-muted">Drop a video here, or</p>
                          <Button className="mt-2" icon={<Icon.upload size={15} />} onClick={() => fileInput.current?.click()}>Choose file</Button>
                          <p className="mt-2 text-xs text-muted">MP4, AVI, MKV, MOV, TS, raw H.264 / H.265 and NVR .cpv exports</p>
                        </>
                      )}
                    </div>
                  )}
                  {(kind === "server_file" || kind === "images") && (
                    <Field id="ac-file" label={kind === "images" ? "Image folder" : "Video file"} hint={files ? `From ${files.dir}` : "Loading the server's videos folder…"}>
                      <Select id="ac-file" value={uri} onChange={(e) => { setUri(e.target.value); const n = e.target.selectedOptions[0]?.dataset.name; if (!name && n) setName(n.replace(/\.[^.]+$/, "").slice(0, 40)); }}>
                        <option value="">Choose…</option>
                        {(kind === "images" ? files?.image_folders ?? [] : files?.files ?? []).map((f) => (
                          <option key={f.uri} value={f.uri} data-name={f.name}>{f.name}{"size" in f ? ` · ${fmtSize(f.size)}` : ""}</option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {(kind === "server_file" || kind === "upload" || kind === "images") && (
                    <Field id="ac-pfps" label="Playback FPS" hint="0 / empty = the file's own rate. Raw NVR exports have none: set it (e.g. 20).">
                      <Input id="ac-pfps" type="number" min={0} max={120} value={fps} onChange={(e) => setFps(e.target.value)} placeholder="auto" className="w-32" />
                    </Field>
                  )}

                  <div className="flex flex-col gap-2" role="group" aria-labelledby="ac-ppe">
                    <span id="ac-ppe" className="text-[13px] font-medium">Required PPE</span>
                    <div className="flex flex-wrap gap-1.5">
                      {ppeItems.map((item) => {
                        const on = ppe.includes(item);
                        const checked = isChecked(item, caps);
                        return (
                          <button key={item} type="button" aria-pressed={on} onClick={() => setPpe(on ? ppe.filter((x) => x !== item) : [...ppe, item])}
                            title={checked ? undefined : "Required, but not checked — the current model can't detect this item."}
                            className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium ${on ? (checked ? "border-primary bg-primary-soft text-primary" : "border-border-strong bg-subtle text-muted") : "border-border text-muted hover:text-text"}`}>
                            {on && (checked ? <Icon.check size={13} /> : <Icon.eyeOff size={13} />)}<span className={checked ? "" : "line-through decoration-border-strong decoration-1"}>{ppeLabel(item)}</span>
                          </button>
                        );
                      })}
                    </div>
                    <UnenforcedNote items={ppe.filter((p) => !isChecked(p, caps))} />
                  </div>

                  <div className="flex flex-col gap-2" role="group" aria-labelledby="ac-behav">
                    <span id="ac-behav" className="text-[13px] font-medium">Behaviour monitoring <span className="font-normal text-muted">· optional</span></span>
                    <Toggle checked={detectPhone} onChange={setDetectPhone} label="Detect phone use" />
                    {detectPhone ? (
                      phoneWarning ? (
                        <Advisory title="Phone use is not checked.">{phoneWarning}</Advisory>
                      ) : (
                        <p className="text-xs text-muted">Flags a worker holding a phone near their hands or face. Runs a second detector, so it adds some inference load — watch System health if you enable it on many cameras.</p>
                      )
                    ) : null}
                  </div>

                  <div className="border-t border-border pt-4">
                    <SourceTester source={source} onResult={setTested} disabled={!uri.trim() || (upload !== null && upload.pct < 100)} />
                    {!tested && uri.trim() && <p className="mt-1 text-xs text-muted">Recommended before adding: checks the address, credentials and codec from the server itself.</p>}
                  </div>
                </>
              )}
            </div>

            {kind && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-4">
                <Button variant="ghost" icon={<Icon.chevronLeft size={15} />} onClick={() => setKind(null)} className="mr-auto">Back</Button>
                <Button onClick={cancel}>Cancel</Button>
                <Button variant="primary" icon={<Icon.plus size={15} />} loading={busy}
                  disabled={!uri.trim() || !name.trim() || !ppe.length || (upload !== null && upload.pct < 100)} onClick={submit}>
                  Add camera
                </Button>
              </div>
            )}
          </Card>
        )}
      </PageBody>
    </>
  );
}
