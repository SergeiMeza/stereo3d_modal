import { LockIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { useServices } from "@/lib/services";
import { cn } from "@/lib/utils";

/** The gateway wants a passkey assertion within this long for money actions. */
const FRESH_MS = 5 * 60_000;

/**
 * In a money confirmation (BL-29 redesign B): says whether confirming will
 * ask for the passkey first (ADR 0135: an assertion within 5 minutes, else
 * 401 reauth_required and the passkey step).
 */
export function PasskeyNote() {
  const { api } = useServices();
  const info = useSyncExternalStore(api.session.subscribe, api.session.details);
  const at = info?.last_assertion_at ? Date.parse(info.last_assertion_at) : NaN;
  const age = Number.isNaN(at) ? null : Date.now() - at;
  const stale = age === null || age > FRESH_MS;
  const mins = age === null ? 0 : Math.max(1, Math.round(age / 60_000));
  return (
    <p
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm",
        stale ? "border-warning/35 bg-warning-bg text-warning-foreground" : "border-border bg-secondary text-muted-foreground",
      )}
      data-testid="passkey-note"
    >
      <LockIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        {age === null
          ? "Money actions need your passkey within the last 5 minutes. If it's been longer, you'll be asked for it when you confirm."
          : stale
            ? `Your passkey was last used ${mins} min ago. Money actions need it within 5 minutes, so you'll be asked for it when you confirm.`
            : `Passkey confirmed ${mins} min ago.`}
      </span>
    </p>
  );
}
