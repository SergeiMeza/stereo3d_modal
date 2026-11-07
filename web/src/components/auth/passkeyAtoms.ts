"use client";

/**
 * The account's passkeys (ADR 0136; ADR 0138: an app-store atom for the
 * account they were read for, no useState copy). Written by the load
 * action and by what an add, rename or remove answered. The gateway
 * client is an action argument.
 */

import { atom } from "jotai";

import type { GatewayClient } from "@/lib/api/client";
import { billingUidAtom } from "@/lib/billing";
import type { Passkey } from "@/lib/passkeys";

export interface PasskeyListState {
  uid: string | null;
  list: Passkey[] | null;
  /** what the load threw (shown with errorText) */
  loadError: { cause: unknown } | null;
}

export const EMPTY_PASSKEYS: PasskeyListState = { uid: null, list: null, loadError: null };

export const passkeyListAtom = atom<PasskeyListState>(EMPTY_PASSKEYS);

/** Read the passkeys again. */
export const loadPasskeysAtom = atom(
  null,
  async (get, set, client: Pick<GatewayClient, "listPasskeys">): Promise<void> => {
    const uid = get(billingUidAtom);
    try {
      const list = await client.listPasskeys();
      if (get(billingUidAtom) === uid) set(passkeyListAtom, { uid, list, loadError: null });
    } catch (e) {
      if (get(billingUidAtom) === uid)
        set(passkeyListAtom, (s) => ({
          uid,
          list: s.uid === uid ? s.list : null,
          loadError: { cause: e },
        }));
    }
  },
);

/** An added or renamed passkey, as the gateway answered it. */
export const putPasskeyAtom = atom(null, (_get, set, p: Passkey) => {
  set(passkeyListAtom, (s) => {
    const list = s.list ?? [];
    const known = list.some((x) => x.id === p.id);
    return { ...s, list: known ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p] };
  });
});

/** A removed passkey. */
export const dropPasskeyAtom = atom(null, (_get, set, id: string) => {
  set(passkeyListAtom, (s) => ({ ...s, list: (s.list ?? []).filter((x) => x.id !== id) }));
});
