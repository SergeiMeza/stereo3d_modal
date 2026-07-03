"use client";

/**
 * Pay-as-you-go billing context. Fetches GET /v1/billing once per signed-in
 * user (the call also ensures the Stripe billing profile server-side, which
 * the old RequireAuth ensureCustomer fire-and-forget used to do) and exposes
 * refresh() for the moments the status changes: after onboarding saves a
 * card, and after a settle attempt.
 *
 * status === null while signed out or until the first fetch resolves —
 * consumers must treat null as "unknown", not "no card". State is keyed by
 * uid (never reset imperatively), so a user switch can't leak the previous
 * account's status and no effect needs to call setState synchronously.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import type { BillingStatus } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";

export interface BillingContextValue {
  /** null = unknown (signed out / still loading / fetch failed) */
  status: BillingStatus | null;
  /** last fetch failed — gates should fail open on errors, not lock users out */
  error: string | null;
  refresh: () => Promise<BillingStatus | null>;
}

const BillingContext = createContext<BillingContextValue>({
  status: null,
  error: null,
  refresh: async () => null,
});

interface BillingState {
  uid: string;
  status: BillingStatus | null;
  error: string | null;
}

export function BillingProvider({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const gateway = useGateway();
  const [state, setState] = useState<BillingState | null>(null);
  // uid the in-flight fetch belongs to — a user switch orphans its result
  const uidRef = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<BillingStatus | null> => {
    const uid = uidRef.current;
    if (uid === null) return null;
    try {
      const s = await gateway.getBilling();
      if (uidRef.current === uid) setState({ uid, status: s, error: null });
      return s;
    } catch (e) {
      const message = e instanceof Error ? e.message : "billing status failed";
      if (uidRef.current === uid) {
        // keep the last good status (if same uid) — an error banner over
        // stale data beats flashing back to "unknown"
        setState((prev) => ({
          uid,
          status: prev?.uid === uid ? prev.status : null,
          error: message,
        }));
      }
      return null;
    }
  }, [gateway]);

  useEffect(() => {
    if (!ready) return;
    const uid = user?.uid ?? null;
    if (uidRef.current === uid) return;
    uidRef.current = uid;
    if (uid !== null) void refresh();
  }, [ready, user, refresh]);

  const currentUid = user?.uid ?? null;
  const current =
    state !== null && state.uid === currentUid ? state : null;

  return (
    <BillingContext.Provider
      value={{
        status: current?.status ?? null,
        error: current?.error ?? null,
        refresh,
      }}
    >
      {children}
    </BillingContext.Provider>
  );
}

export function useBilling(): BillingContextValue {
  return useContext(BillingContext);
}
