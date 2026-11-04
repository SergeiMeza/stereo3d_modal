import { atom, useAtomValue } from "jotai";

import type { AdminApi } from "@/lib/api";
import type { AdminAuth } from "@/lib/auth";

/**
 * The console's services (ADR 0138): the gateway client and the Google
 * sign-in, set once per signed-in store by App. They're dependencies, not
 * state: the passkey session token stays inside AdminSession
 * (sessionStorage), never in an atom, and nothing here is persisted.
 */
export interface Services {
  api: AdminApi;
  auth: AdminAuth;
  /** the signed-in owner's email (Google) */
  email: string;
}

export const servicesAtom = atom<Services | null>(null);

export function useServicesAtom(): Services {
  const s = useAtomValue(servicesAtom);
  if (!s) throw new Error("services aren't set: render inside App");
  return s;
}

/** For derived and action atoms. */
export function apiOf(s: Services | null): AdminApi {
  if (!s) throw new Error("services aren't set: render inside App");
  return s.api;
}
