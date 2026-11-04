"use client";

/**
 * A small "?" / "How pricing works" popover (S3D-45): details sit behind
 * it, not on the page. Built on the shadcn Popover (owner 2026-11-04): it
 * opens on click or tap (touch and headset browsers too), is portalled,
 * and flips and shifts to stay 16px inside the viewport.
 */

import type { JSX, ReactNode } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

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
  /** which edge of the trigger the popover lines up with first */
  align?: "left" | "right";
}): JSX.Element {
  return (
    <span className={`inline-block ${className}`}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={
              label === "?"
                ? "inline-flex size-4 items-center justify-center rounded-full border border-edge text-[10px] text-fg-muted hover:text-fg"
                : "text-xs text-primary hover:underline"
            }
          >
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align={align === "right" ? "end" : "start"}
          className="flex flex-col gap-2 text-left text-fg"
        >
          {children}
        </PopoverContent>
      </Popover>
    </span>
  );
}
