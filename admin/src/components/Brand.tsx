import { cn } from "@/lib/utils";

export function Brand({ big = false, env }: { big?: boolean; env?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight whitespace-nowrap", big && "text-lg")}>
      {/* the Spatial Video Studio app icon (owner 2026-11-04), as a CSS
          background so customer-text checks for <img> stay meaningful */}
      <span className={cn("brand-icon flex-none rounded-[22%]", big ? "size-6" : "size-4.5")} aria-hidden="true" />
      Spatial Video Studio
      <span className="rounded-md border border-warning/40 px-1.5 py-px font-mono text-2xs font-medium text-warning">
        admin{env && env !== "prod" ? ` · ${env}` : ""}
      </span>
    </span>
  );
}
