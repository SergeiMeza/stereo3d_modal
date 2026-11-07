/**
 * EM-02: the account's sign-in methods as the gateway read them (ADR 0138:
 * an app-store atom for the account it was read for). The actions live in
 * identityAtoms.ts.
 */

import { atom } from "jotai";

import type { AccountIdentities } from "@/lib/api/client";
import { EN, type Tr } from "@/lib/i18n/t";

export interface IdentitiesState {
  uid: string | null;
  data: AccountIdentities | null;
  error: string | null;
}

export const EMPTY_IDENTITIES: IdentitiesState = { uid: null, data: null, error: null };

export const identitiesAtom = atom<IdentitiesState>(EMPTY_IDENTITIES);

/** The other account's ways in, as the gateway names them (Apple and
 * Google stay as they are). */
const METHOD_WORDS: Record<string, string | null> = {
  "apple.com": "Apple",
  "google.com": "Google",
  email: null,
  passkey: null,
};

const METHOD_WORD_KEYS: Record<string, string> = {
  email: "auth.providers.emailCode",
  passkey: "auth.providers.passkey",
};

export function providersWords(providers: string[], t: Tr = EN): string {
  const words = providers
    .filter((p) => p in METHOD_WORDS)
    .map((p) => METHOD_WORDS[p] ?? t(METHOD_WORD_KEYS[p]))
    .filter((w): w is string => !!w);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  return t("auth.providers.or", { list: words.slice(0, -1).join(t("auth.providers.separator")), last: words.at(-1) });
}
