/**
 * Plan & billing's "Your prices per minute": open or folded, kept for the
 * visit (ADR 0138: an app-store atom). Open by default.
 */

import { atom } from "jotai";

export const yourPricesOpenAtom = atom(true);
