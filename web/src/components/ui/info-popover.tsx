"use client";

/**
 * A small "?" / "How pricing works" popover (S3D-45): details sit behind
 * it, not on the page. Click to open, click outside or Escape to close.
 */

import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

export function InfoPopover({
  label,
  children,
  className = "",
  align = "left",
}: {
  /** the trigger's text: "?" or "How pricing works" */
  label: ReactNode;
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={ref} className={`relative inline-block ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          label === "?"
            ? "inline-flex size-4 items-center justify-center rounded-full border border-edge text-[10px] text-fg-muted hover:text-fg"
            : "text-xs text-primary hover:underline"
        }
      >
        {label}
      </button>
      {open ? (
        <span
          role="dialog"
          className={`absolute top-full z-50 mt-2 flex w-80 max-w-[90vw] flex-col gap-2 rounded-lg border border-edge bg-popover p-3 text-left text-xs leading-relaxed text-fg shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
