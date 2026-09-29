import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "danger-ghost";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-on-primary hover:bg-primary-hover border-transparent shadow-sm",
  secondary: "bg-surface text-text border-border hover:bg-subtle shadow-sm",
  danger: "bg-danger text-white hover:bg-danger-hover border-transparent shadow-sm",
  ghost: "bg-transparent text-muted border-transparent hover:bg-subtle hover:text-text",
  "danger-ghost": "bg-transparent text-danger border-transparent hover:bg-danger-soft",
};
const SIZES: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export function Button({ variant = "secondary", size = "md", icon, loading, children, className = "", disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/** Square icon-only button; `label` is required for screen readers and the tooltip. */
export function IconButton({ label, children, className = "", variant = "ghost", size = "md", ...rest }: ButtonProps & { label: string }) {
  const dim = size === "sm" ? "h-8 w-8" : "h-9 w-9";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${dim} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
