/**
 * Form fields bound to a dotted path of the config document, so a settings section is a plain list of
 * fields. Limits, defaults and enums come from the server's JSON schema (`fieldMeta`), never from here.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { fieldMeta, getIn, sameJson } from "../../lib/configForm";
import type { ConfigSchema, RawConfig } from "../../types";
import { Button, cx, Field, Input, Select, Switch, Tag } from "../ui";

export interface FormCtx {
  draft: RawConfig;
  /** the saved document, to mark what was edited */
  saved: RawConfig;
  /** `undefined` removes the key, so the server default applies again */
  set: (path: string, value: unknown) => void;
  /** field errors by dotted path */
  errors: Record<string, string>;
  schema: ConfigSchema | null;
  disabled?: boolean;
}

export const ConfigFormContext = createContext<FormCtx | null>(null);

function useForm(): FormCtx {
  const c = useContext(ConfigFormContext);
  if (!c) throw new Error("config fields must be used inside <ConfigFormContext.Provider>");
  return c;
}

interface Base {
  path: string;
  label: string;
  /** what changing it does, in one line */
  hint?: ReactNode;
  className?: string;
}

function useField(path: string) {
  const f = useForm();
  const meta = fieldMeta(f.schema?.schema, path);
  const value = getIn(f.draft, path);
  // an error on a child path (a list item) belongs to the field too
  const error = f.errors[path] ?? Object.entries(f.errors).find(([k]) => k.startsWith(`${path}.`))?.[1] ?? null;
  return {
    ...f, meta, value, error,
    edited: !sameJson(value ?? null, getIn(f.saved, path) ?? null),
    restart: !!f.schema?.restart_required.includes(path),
  };
}

function Label({ label, unit, edited, restart }: { label: string; unit?: string; edited: boolean; restart: boolean }) {
  return (
    <>
      <span>{label}</span>
      {unit && <span className="font-normal text-ink-3">{unit}</span>}
      {restart && <Tag tone="warn">needs server restart</Tag>}
      {edited && <span className="text-xs font-normal text-accent">edited</span>}
    </>
  );
}

const fmtNum = (n: number) => String(Math.round(n * 1e6) / 1e6);

/** "0.05 to 0.95 · default 0.35" from the schema. */
function limits(meta: ReturnType<typeof fieldMeta>): string {
  const parts: string[] = [];
  const min = meta.minimum, max = meta.maximum;
  if (min !== undefined && max !== undefined) parts.push(`${fmtNum(min)} to ${fmtNum(max)}`);
  else if (min !== undefined) parts.push(`${fmtNum(min)} or more`);
  else if (meta.exclusiveMinimum !== undefined && max !== undefined) parts.push(`above ${fmtNum(meta.exclusiveMinimum)}, up to ${fmtNum(max)}`);
  else if (meta.exclusiveMinimum !== undefined) parts.push(`above ${fmtNum(meta.exclusiveMinimum)}`);
  else if (max !== undefined) parts.push(`up to ${fmtNum(max)}`);
  if (meta.multipleOf) parts.push(`multiple of ${meta.multipleOf}`);
  if (typeof meta.default === "number") parts.push(`default ${fmtNum(meta.default)}`);
  return parts.join(" · ");
}

export function FieldGrid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return <div className={cx("grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2", cols === 3 && "xl:grid-cols-3")}>{children}</div>;
}

export function TextField({ path, label, hint, className, placeholder, mono }: Base & { placeholder?: string; mono?: boolean }) {
  const { value, set, error, meta, disabled, edited, restart } = useField(path);
  return (
    <Field label={<Label label={label} edited={edited} restart={restart} />} hint={hint} error={error} className={className}>
      {(id) => (
        <Input id={id} value={value == null ? "" : String(value)} disabled={disabled} invalid={!!error} spellCheck={false}
          className={mono ? "num" : undefined}
          placeholder={placeholder ?? (typeof meta.default === "string" && meta.default ? meta.default : undefined)}
          onChange={(e) => set(path, e.target.value === "" && meta.default !== undefined ? undefined : e.target.value)} />
      )}
    </Field>
  );
}

/** Number input. Empty removes the key so the default applies. A `${VAR}` placeholder stays editable as text. */
export function NumberField({ path, label, hint, className, unit, step }: Base & { unit?: string; step?: number }) {
  const { value, set, error, meta, disabled, edited, restart } = useField(path);
  const template = typeof value === "string";
  const range = limits(meta);
  return (
    <Field label={<Label label={label} unit={unit} edited={edited} restart={restart} />} error={error} className={className}
      hint={<>{hint}{hint && range ? " " : ""}{range && <span className="num whitespace-nowrap">{range}</span>}</>}>
      {(id) => (
        <Input id={id} type={template ? "text" : "number"} inputMode="decimal" className="num" disabled={disabled} invalid={!!error}
          step={step ?? meta.multipleOf ?? "any"} min={meta.minimum} max={meta.maximum}
          value={value == null ? "" : String(value)}
          placeholder={typeof meta.default === "number" ? fmtNum(meta.default) : undefined}
          onChange={(e) => {
            const t = e.target.value;
            if (t === "") set(path, undefined);
            else set(path, template || Number.isNaN(Number(t)) ? t : Number(t));
          }} />
      )}
    </Field>
  );
}

export function SelectField({ path, label, hint, className, options, numeric }:
  Base & { options?: { value: string; label: string }[]; numeric?: boolean }) {
  const { value, set, error, meta, disabled, edited, restart } = useField(path);
  const current = String(value ?? meta.default ?? "");
  const opts = options ?? (meta.enum ?? []).map((v) => ({ value: String(v), label: String(v) }));
  // a value the list doesn't offer (hand-edited YAML) stays selectable instead of silently changing
  const all = current !== "" && !opts.some((o) => o.value === current) ? [{ value: current, label: current }, ...opts] : opts;
  return (
    <Field label={<Label label={label} edited={edited} restart={restart} />} hint={hint} error={error} className={className}>
      {(id) => (
        <Select id={id} value={current} disabled={disabled} invalid={!!error}
          onChange={(e) => set(path, numeric ? Number(e.target.value) : e.target.value)}>
          {all.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      )}
    </Field>
  );
}

export function ToggleField({ path, label, hint, className }: Base) {
  const { value, set, error, meta, disabled, edited, restart } = useField(path);
  const on = !!(value ?? meta.default ?? false);
  return (
    <div className={cx("min-w-0", className)}>
      <Switch checked={on} disabled={disabled} onChange={(v) => set(path, v)} hint={hint}
        label={<span className="flex flex-wrap items-baseline gap-1.5 font-medium"><Label label={label} edited={edited} restart={restart} /></span>} />
      {error && <p role="alert" className="mt-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

/** A list of strings edited as comma-separated text (email recipients, allowed origins). */
export function ListField({ path, label, hint, className, placeholder }: Base & { placeholder?: string }) {
  const { value, set, error, disabled, edited, restart } = useField(path);
  const [text, setText] = useState<string | null>(null); // the raw text while the field has focus
  const joined = Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value);
  return (
    <Field label={<Label label={label} edited={edited} restart={restart} />} hint={hint} error={error} className={className}>
      {(id) => (
        <Input id={id} value={text ?? joined} disabled={disabled} invalid={!!error} spellCheck={false} placeholder={placeholder}
          onFocus={() => setText(joined)} onBlur={() => setText(null)}
          onChange={(e) => {
            setText(e.target.value);
            set(path, e.target.value.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean));
          }} />
      )}
    </Field>
  );
}

const ENV_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/;

/**
 * A secret kept in the config file. A stored value is never rendered: the field only says that one
 * exists. Typing replaces it; leaving the field alone sends the stored value back untouched.
 * An environment placeholder such as ${PPE_SMTP_PASSWORD} is a reference, not a secret, so it is shown.
 */
export function SecretField({ path, label, hint, className }: Base) {
  const { value, saved, set, error, disabled, edited, restart } = useField(path);
  const stored = getIn(saved, path);
  const hasStored = typeof stored === "string" && stored !== "";
  const cur = typeof value === "string" ? value : "";
  const untouched = hasStored && cur === stored;
  const reference = ENV_PLACEHOLDER.test(cur);
  const hidden = untouched && !reference;
  return (
    <Field label={<Label label={label} edited={edited} restart={restart} />} error={error} className={className}
      hint={hidden ? "A secret is stored and is not shown. Type to replace it." : hint}>
      {(id) => (
        <div className="flex gap-2">
          <Input id={id} type={reference ? "text" : "password"} autoComplete="new-password" spellCheck={false}
            className={reference ? "num" : undefined} disabled={disabled} invalid={!!error}
            value={hidden ? "" : cur} placeholder={hidden ? "Stored" : "Not set"}
            onChange={(e) => set(path, e.target.value === "" ? (hasStored ? stored : undefined) : e.target.value)} />
          {hasStored && cur !== "" && <Button variant="ghost" disabled={disabled} onClick={() => set(path, "")}>Remove</Button>}
          {hasStored && cur === "" && <Button variant="ghost" disabled={disabled} onClick={() => set(path, stored)}>Keep stored</Button>}
        </div>
      )}
    </Field>
  );
}
