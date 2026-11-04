import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

import { safeExternalUrl } from "../lib/links";

type Variant = "primary" | "outline" | "ghost" | "danger";
type Size = "md" | "sm" | "xs" | "lg";

export function Button({
  variant = "outline",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      className={`btn ${variant} ${size === "md" ? "" : size} ${className}`.trim()}
      {...rest}
    />
  );
}

export type Tone = "blue" | "green" | "amber" | "red" | "violet" | "plain" | "muted";

export function Chip({ tone = "plain", children }: { tone?: string; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spin" role="status" aria-label={label} />;
}

export function SkeletonRows({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="card" aria-busy="true" aria-label="Loading">
      <table className="at">
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} data-testid="skeleton-row">
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>
                  <span className="skel" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StateBox({
  tone = "muted",
  title,
  children,
  action,
}: {
  tone?: "muted" | "error";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`statebox ${tone}`} role={tone === "error" ? "alert" : undefined}>
      {tone === "error" && <span className="statebox-ic" aria-hidden="true">!</span>}
      <p className="statebox-title">{title}</p>
      {children && <div className="muted small">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ title, message, onRetry }: { title: string; message?: string; onRetry?: () => void }) {
  return (
    <StateBox
      tone="error"
      title={title}
      action={onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
    >
      {message}
    </StateBox>
  );
}

export function Banner({
  tone = "blue",
  children,
  action,
}: {
  tone?: "blue" | "amber" | "red";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`banner ${tone}`} role="status">
      <span className="grow">{children}</span>
      {action}
    </div>
  );
}

/** External link to an allowed host, else the text without a link. */
export function ExtLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  const safe = safeExternalUrl(href);
  if (!safe) return <span className="muted">{children}</span>;
  return (
    <a className="link ext" href={safe} target="_blank" rel="noopener noreferrer">
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

/** Modal sheet (confirm sheets, forms). Esc and the scrim close it. */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
  busy,
  alert,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
  busy?: boolean;
  /** A confirm for something that can't be undone: role alertdialog. */
  alert?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      "input, textarea, select, button.primary, button",
    );
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={ref}
        className={`sheet ${wide ? "wide" : ""}`}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="sheet-head">
          <div className="grow">
            <h2 id={titleId} className="sheet-title">{title}</h2>
            {subtitle && <div className="sheet-sub">{subtitle}</div>}
          </div>
          <button type="button" className="x" aria-label="Close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        <div className="sheet-foot">{footer}</div>
      </div>
    </div>
  );
}

/** Customer-supplied or free text: plain text, line breaks kept, no links. */
export function PlainText({ text, className = "" }: { text: string | null | undefined; className?: string }) {
  return <p className={`plain ${className}`.trim()}>{text ?? ""}</p>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
