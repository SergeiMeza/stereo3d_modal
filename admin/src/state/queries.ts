import { createQuery } from "./query";
import { apiOf, servicesAtom } from "./services";
import type { CaseListQuery } from "@/lib/api";

/**
 * The console's gateway reads, one query each (ADR 0138). Params are the
 * request's own arguments, so two screens asking the same thing share one
 * answer (Overview's plan starts and Plans surfaces' 7-day view).
 */

export const policyQuery = createQuery((get, _: null) => apiOf(get(servicesAtom)).policy());
export const mailPreviewsQuery = createQuery((get, _: null) => apiOf(get(servicesAtom)).mailPreviews());
export const plansSurfacesQuery = createQuery((get, days: number) => apiOf(get(servicesAtom)).plansSurfaces(days));
export const onboardingQuery = createQuery((get, days: number) => apiOf(get(servicesAtom)).onboardingHeadsets(days));
export const businessFunnelQuery = createQuery((get, days: number) => apiOf(get(servicesAtom)).businessFunnel(days));
export const feedbackQuery = createQuery((get, p: { days: number; platform: string }) =>
  apiOf(get(servicesAtom)).feedback(p.days, p.platform),
);
export const passkeyAdoptionQuery = createQuery((get, _: null) => apiOf(get(servicesAtom)).passkeyAdoption());
export const disputesQuery = createQuery((get, months: number) => apiOf(get(servicesAtom)).disputes(months));
export const efwsQuery = createQuery((get, _: null) => apiOf(get(servicesAtom)).openEfws());
export const grantsQuery = createQuery((get, _: null) => apiOf(get(servicesAtom)).allGrants());
export const casesQuery = createQuery((get, q: CaseListQuery) => apiOf(get(servicesAtom)).listCases(q));
export const caseQuery = createQuery((get, id: string) => apiOf(get(servicesAtom)).getCase(id));
export const accountQuery = createQuery((get, uid: string) => apiOf(get(servicesAtom)).getAccount(uid));
export const passkeysQuery = createQuery((get, _: null) => apiOf(get(servicesAtom)).listPasskeys());
