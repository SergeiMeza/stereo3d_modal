"use client";

/**
 * EM-02 (owner 2026-11-06): the account's sign-in methods through the
 * gateway (GET/POST/DELETE /v1/account/identities), not the Firebase SDK,
 * for every account and in China mode. ADR 0138: the list is an app-store
 * atom for the account it was read for; the gateway client and the auth
 * helpers are action arguments. reauth_required goes through the shared
 * "Confirm it's you" (lib/reauth) inside the client.
 */

import { atom } from "jotai";

import { GatewayError } from "@/lib/api/client";
import type { GatewayClient } from "@/lib/api/client";
import { AppleCancelled, appleAuthorize, type AppleAnswer } from "@/lib/appleJs";
import { billingUidAtom } from "@/lib/billing";

type Client = Pick<GatewayClient, "getIdentities" | "linkIdentity" | "unlinkIdentity">;

import { identitiesAtom } from "./identityState";

export { EMPTY_IDENTITIES, identitiesAtom, providersWords, type IdentitiesState } from "./identityState";
import { providersWords } from "./identityState";

/** 409 credential_in_use: that sign-in is another account's. Offers
 * "Sign in to that account" (switches) when it can. */
export class IdentityInUseError extends Error {
  constructor(
    readonly providers: string[],
    readonly switchTo: (() => Promise<void>) | null,
  ) {
    const how = providersWords(providers);
    super(
      `That sign-in belongs to another account${how ? ` (it signs in with ${how})` : ""}.`,
    );
    this.name = "IdentityInUseError";
  }
}

/** Read the sign-in methods again. */
export const loadIdentitiesAtom = atom(null, async (get, set, client: Client): Promise<void> => {
  const uid = get(billingUidAtom);
  try {
    const data = await client.getIdentities();
    if (get(billingUidAtom) === uid) set(identitiesAtom, { uid, data, error: null });
  } catch (e) {
    if (get(billingUidAtom) === uid)
      set(identitiesAtom, (s) => ({
        uid,
        data: s.uid === uid ? s.data : null,
        error: e instanceof Error ? e.message : "Couldn't load your sign-in methods.",
      }));
  }
});

function inUse(e: unknown): string[] | null {
  if (!(e instanceof GatewayError) || e.code !== "credential_in_use") return null;
  const p = e.details?.providers;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
}

/** Add Apple: Apple's popup, then POST link with its ID token and the raw
 * nonce. "cancelled" when the person closed Apple's window. */
export const linkAppleAtom = atom(
  null,
  async (
    get,
    set,
    a: {
      client: Client;
      reloadUser: () => Promise<void>;
      signInWithAppleToken: (idToken: string, rawNonce: string) => Promise<void>;
      authorize?: () => Promise<AppleAnswer>;
    },
  ): Promise<"done" | "cancelled"> => {
    let answer: AppleAnswer;
    try {
      answer = await (a.authorize ?? appleAuthorize)();
    } catch (e) {
      if (e instanceof AppleCancelled) return "cancelled";
      throw e;
    }
    const uid = get(billingUidAtom);
    try {
      const data = await a.client.linkIdentity({ provider: "apple.com", id_token: answer.idToken, nonce: answer.rawNonce });
      if (get(billingUidAtom) === uid) set(identitiesAtom, { uid, data, error: null });
    } catch (e) {
      const providers = inUse(e);
      if (providers !== null) {
        throw new IdentityInUseError(providers, () => a.signInWithAppleToken(answer.idToken, answer.rawNonce));
      }
      throw e;
    }
    await a.reloadUser().catch(() => undefined);
    return "done";
  },
);

/** Remove Apple, Google or a password. */
export const unlinkIdentityAtom = atom(
  null,
  async (
    get,
    set,
    a: { client: Client; provider: string; reloadUser: () => Promise<void> },
  ): Promise<void> => {
    const uid = get(billingUidAtom);
    try {
      const data = await a.client.unlinkIdentity(a.provider);
      if (get(billingUidAtom) === uid) set(identitiesAtom, { uid, data, error: null });
    } catch (e) {
      // already gone elsewhere: show what's there now
      if (e instanceof GatewayError && e.code === "not_linked") {
        const data = await a.client.getIdentities().catch(() => null);
        if (data && get(billingUidAtom) === uid) set(identitiesAtom, { uid, data, error: null });
        return;
      }
      throw e;
    }
    await a.reloadUser().catch(() => undefined);
  },
);
