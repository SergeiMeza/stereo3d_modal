"use client";

/**
 * The account's emails (gateway 00152, owner 2026-11-06): up to five, any
 * of them signs in with the email code, one is main (receipts and Restore
 * Purchases use it). ADR 0138: the list is an app-store atom for the
 * account it was read for; the gateway client and the auth helpers are
 * action arguments. Every write needs a fresh sign-in, which the client
 * asks for through the shared "Confirm it's you".
 */

import { atom } from "jotai";

import { GatewayError } from "@/lib/api/client";
import type { AccountEmails, GatewayClient } from "@/lib/api/client";
import { enText, errorText, keyed, keyedError } from "@/lib/authErrors";
import { billingUidAtom } from "@/lib/billing";
import { codeMailLanguage } from "@/lib/emailCode";
import { EN, type Tr } from "@/lib/i18n/t";

import { providersWords } from "./identityState";

type Client = Pick<GatewayClient, "getEmails" | "startAddEmail" | "addEmail" | "makeMainEmail" | "removeEmail">;

export interface EmailsState {
  uid: string | null;
  data: AccountEmails | null;
  error: string | null;
}

export const EMPTY_EMAILS: EmailsState = { uid: null, data: null, error: null };
export const emailsAtom = atom<EmailsState>(EMPTY_EMAILS);

export const MAX_EMAILS = 5;
export const RELAY_NOT_MAIN = EN("auth.emails.relayNotMain");
export const MAIN_NOT_REMOVABLE = EN("auth.emails.mainNotRemovable");

/** 409 credential_in_use: the address is another account's. Its code is
 * left unspent, so "Sign in to that account" can use it. */
export class EmailInUseError extends Error {
  constructor(readonly providers: string[]) {
    const key = providersWords(providers) ? "auth.inUse.emailHow" : "auth.inUse.email";
    const values = (t: Tr) => ({ how: providersWords(providers, t) });
    super(enText(key, values));
    this.name = "EmailInUseError";
    keyed(this, key, values);
  }
}

/** The gateway's refusals, in plain words. */
export function emailError(e: unknown): Error {
  if (e instanceof GatewayError) {
    if (e.code === "credential_in_use") {
      const p = e.details?.providers;
      return new EmailInUseError(Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : []);
    }
    if (e.code === "relay_not_main") return keyedError("auth.emails.relayNotMain");
    if (e.code === "main_email_not_removable") return keyedError("auth.emails.mainNotRemovable");
  }
  return e instanceof Error ? e : keyedError("auth.errors.didntWork");
}

function store(get: () => string | null, set: (v: EmailsState) => void, uid: string | null, data: AccountEmails): void {
  if (get() === uid) set({ uid, data, error: null });
}

export const loadEmailsAtom = atom(null, async (get, set, client: Client): Promise<void> => {
  const uid = get(billingUidAtom);
  try {
    const data = await client.getEmails();
    if (get(billingUidAtom) === uid) set(emailsAtom, { uid, data, error: null });
  } catch (e) {
    if (get(billingUidAtom) === uid)
      set(emailsAtom, (s) => ({ uid, data: s.uid === uid ? s.data : null, error: errorText(e, EN, "auth.emails.loadFailed") }));
  }
});

/** Mail a code to the address to add. */
export async function sendAddEmailCode(client: Client, email: string): Promise<void> {
  await client.startAddEmail(email.trim(), codeMailLanguage());
}

/** A write that answers the list: store it, and read the session again
 * when the main email changed. */
async function write(
  get: <V>(a: import("jotai").Atom<V>) => V,
  set: (a: typeof emailsAtom, v: EmailsState) => void,
  op: () => Promise<AccountEmails>,
  reloadUser: () => Promise<void>,
): Promise<AccountEmails> {
  const uid = get(billingUidAtom);
  let data: AccountEmails;
  try {
    data = await op();
  } catch (e) {
    throw emailError(e);
  }
  store(() => get(billingUidAtom), (v) => set(emailsAtom, v), uid, data);
  if (data.refresh_token) await reloadUser().catch(() => undefined);
  return data;
}

export const addEmailAtom = atom(
  null,
  (get, set, a: { client: Client; email: string; code: string; makeMain: boolean; reloadUser: () => Promise<void> }) =>
    write(get, set, () => a.client.addEmail({ email: a.email.trim(), code: a.code, ...(a.makeMain ? { make_main: true } : {}) }), a.reloadUser),
);

export const makeMainEmailAtom = atom(
  null,
  (get, set, a: { client: Client; id: string; reloadUser: () => Promise<void> }) =>
    write(get, set, () => a.client.makeMainEmail(a.id), a.reloadUser),
);

export const removeEmailAtom = atom(
  null,
  (get, set, a: { client: Client; id: string; reloadUser: () => Promise<void> }) =>
    write(get, set, () => a.client.removeEmail(a.id), a.reloadUser),
);
