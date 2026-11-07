/**
 * BUX-02: a payment session the gateway opened ends at its expires_at (a
 * top-up's after 30 minutes). An idle sheet past it says it timed out,
 * not that the method was declined.
 */

import { useEffect, useRef } from "react";

/** Calls onExpire once when expiresAt passes, while active. */
export function useSessionExpiry(expiresAt: string | undefined, active: boolean, onExpire: () => void): void {
  const cb = useRef(onExpire);
  useEffect(() => {
    cb.current = onExpire;
  });
  useEffect(() => {
    if (!active || !expiresAt) return;
    const at = Date.parse(expiresAt);
    if (!Number.isFinite(at)) return;
    const timer = setTimeout(() => cb.current(), Math.max(at - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [expiresAt, active]);
}
