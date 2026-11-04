"use client";

/**
 * The account's settings (GET/PATCH /v1/account/settings), shared by every
 * component that needs them: onboarding (welcome, getting started, tips,
 * first-time hints) and the Make 3D page's headset preselection. One load
 * per signed-in account; updates apply at once and are saved on the
 * account, so they follow the person to other browsers (owner 2026-11-04:
 * server-side, not localStorage).
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { AccountSettings, AccountSettingsPatch } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";

interface Cache {
  uid: string;
  settings: AccountSettings | null;
  loading: Promise<void> | null;
}

let cache: Cache | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Tests: forget the loaded settings. */
export function resetAccountSettingsCache(): void {
  cache = null;
  emit();
}

function merge(s: AccountSettings, patch: AccountSettingsPatch): AccountSettings {
  return {
    ...s,
    ...(patch.lifelike_intro !== undefined ? { lifelike_intro: patch.lifelike_intro } : {}),
    ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
    ...(patch.simulate_app_pro !== undefined ? { simulate_app_pro: patch.simulate_app_pro } : {}),
    ...(patch.business_setup ? { business_setup: { ...s.business_setup, ...patch.business_setup } } : {}),
    ...(patch.headsets !== undefined ? { headsets: patch.headsets } : {}),
    ...(patch.hints_seen_add
      ? { hints_seen: [...new Set([...(s.hints_seen ?? []), ...patch.hints_seen_add])] }
      : {}),
    ...(patch.onboarding ? { onboarding: { ...s.onboarding, ...patch.onboarding } } : {}),
    ...(patch.dismissed ? { dismissed: mergeDismissed(s.dismissed ?? {}, patch.dismissed) } : {}),
  };
}

function mergeDismissed(
  cur: Record<string, string>,
  patch: Record<string, true | string | null>,
): Record<string, string> {
  const out = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v === true ? new Date().toISOString() : v;
  }
  return out;
}

export interface AccountSettingsApi {
  /** null while loading, signed out, or when the gateway can't answer */
  settings: AccountSettings | null;
  update: (patch: AccountSettingsPatch) => void;
  /** reload (e.g. after a run finishes, for the getting-started steps) */
  refresh: () => void;
}

export function useAccountSettings(): AccountSettingsApi {
  const gateway = useGateway();
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const snapshot = useSyncExternalStore(
    subscribe,
    () => cache,
    () => null,
  );

  const load = useCallback(
    (force = false) => {
      if (uid === null) return;
      if (!force && cache?.uid === uid && (cache.settings !== null || cache.loading !== null)) return;
      const entry: Cache = { uid, settings: cache?.uid === uid ? cache.settings : null, loading: null };
      entry.loading = gateway
        .getAccountSettings()
        .then((s) => {
          if (cache === entry) {
            cache = { ...entry, settings: s, loading: null };
            emit();
          }
        })
        .catch(() => {
          if (cache === entry) {
            cache = { ...entry, loading: null };
            emit();
          }
        });
      cache = entry;
      emit();
    },
    [gateway, uid],
  );

  useEffect(() => {
    load();
  }, [load]);

  const update = useCallback(
    (patch: AccountSettingsPatch) => {
      if (uid === null) return;
      if (cache?.uid === uid && cache.settings) {
        cache = { ...cache, settings: merge(cache.settings, patch) };
        emit();
      }
      gateway
        .patchAccountSettings(patch)
        .then((s) => {
          if (cache?.uid === uid) {
            cache = { ...cache, settings: s };
            emit();
          }
        })
        .catch(() => {});
    },
    [gateway, uid],
  );

  const settings = snapshot && snapshot.uid === uid ? snapshot.settings : null;
  return { settings, update, refresh: () => load(true) };
}
