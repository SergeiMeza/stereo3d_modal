/**
 * EM-02: the account's sign-in methods as the gateway read them (ADR 0138:
 * an app-store atom for the account it was read for). The actions live in
 * identityAtoms.ts.
 */

import { atom } from "jotai";

import type { AccountIdentities } from "@/lib/api/client";

export interface IdentitiesState {
  uid: string | null;
  data: AccountIdentities | null;
  error: string | null;
}

export const EMPTY_IDENTITIES: IdentitiesState = { uid: null, data: null, error: null };

export const identitiesAtom = atom<IdentitiesState>(EMPTY_IDENTITIES);

/** The other account's ways in, as the gateway names them. */
const METHOD_WORDS: Record<string, string> = {
  "apple.com": "Apple",
  "google.com": "Google",
  email: "an email code",
  passkey: "a passkey",
};

export function providersWords(providers: string[]): string {
  const words = providers.map((p) => METHOD_WORDS[p]).filter((w): w is string => !!w);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}
