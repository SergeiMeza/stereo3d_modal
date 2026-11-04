"use client";

/**
 * The account's settings (GET/PATCH /v1/account/settings), shared by every
 * component that needs them: onboarding (welcome, getting started, tips,
 * first-time hints) and the Make 3D page's headset preselection. One load
 * per signed-in account; updates apply at once and are saved on the
 * account, so they follow the person to other browsers (owner 2026-11-04:
 * server-side, not localStorage).
 */

import { atom } from "jotai";
import { useCallback, useEffect } from "react";

import type { AccountSettings, AccountSettingsPatch } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { appStore, useAppAtomValue } from "@/lib/state/stores";

/** ADR 0138: the account's settings in an app-store atom, for the account
 * they were read for. */
interface Cache {
  uid: string;
  settings: AccountSettings | null;
  loading: boolean;
}

export const accountSettingsAtom = atom<Cache | null>(null);

const get = (): Cache | null => appStore.get(accountSettingsAtom);
const put = (c: Cache | null): void => appStore.set(accountSettingsAtom, c);

/** Tests: forget the loaded settings. */
export function resetAccountSettingsCache(): void {
  put(null);
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
  /** show these settings now (an optimistic change, or putting one back) */
  replace: (settings: AccountSettings) => void;
  /** save a change and show what the gateway answered; throws on failure */
  save: (patch: AccountSettingsPatch) => Promise<AccountSettings>;
}

export function useAccountSettings(): AccountSettingsApi {
  const gateway = useGateway();
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const snapshot = useAppAtomValue(accountSettingsAtom);

  const load = useCallback(
    (force = false) => {
      if (uid === null) return;
      const c = get();
      if (!force && c?.uid === uid && (c.settings !== null || c.loading)) return;
      put({ uid, settings: c?.uid === uid ? c.settings : null, loading: true });
      gateway
        .getAccountSettings()
        .then((settings) => {
          if (get()?.uid === uid) put({ uid, settings, loading: false });
        })
        .catch(() => {
          const now = get();
          if (now?.uid === uid) put({ ...now, loading: false });
        });
    },
    [gateway, uid],
  );

  useEffect(() => {
    load();
  }, [load]);

  const update = useCallback(
    (patch: AccountSettingsPatch) => {
      if (uid === null) return;
      const c = get();
      if (c?.uid === uid && c.settings) put({ ...c, settings: merge(c.settings, patch) });
      gateway
        .patchAccountSettings(patch)
        .then((settings) => {
          const now = get();
          if (now?.uid === uid) put({ ...now, settings });
        })
        .catch(() => {});
    },
    [gateway, uid],
  );

  const replace = useCallback(
    (settings: AccountSettings) => {
      if (uid !== null) put({ uid, settings, loading: false });
    },
    [uid],
  );

  const save = useCallback(
    async (patch: AccountSettingsPatch) => {
      const settings = await gateway.patchAccountSettings(patch);
      if (uid !== null && get()?.uid === uid) put({ uid, settings, loading: false });
      return settings;
    },
    [gateway, uid],
  );

  const settings = snapshot && snapshot.uid === uid ? snapshot.settings : null;
  return { settings, update, refresh: () => load(true), replace, save };
}
