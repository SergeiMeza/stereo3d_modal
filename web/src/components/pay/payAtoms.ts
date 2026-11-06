/**
 * Which app-wide pay sheet is open (ADR 0138: app-store atoms, no
 * context). Kept free of UI imports so the test setup can reset them.
 */

import { atom } from "jotai";

/** The settle sheet (P2) is open. */
export const settleOpenAtom = atom(false);

/** The open balance dialog: Add funds (P17), Auto-reload (P18), Spending (P19). */
export const balanceDialogAtom = atom<"funds" | "reload" | "spending" | null>(null);

/** Gateway 00152: the email the last paid checkout session carried (the
 * plan's "Add an email for your plan" starts from it). */
export const checkoutEmailAtom = atom<string | null>(null);
