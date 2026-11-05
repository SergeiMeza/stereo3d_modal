"use client";

/**
 * The welcome's headset picks (ADR 0138; owner bug 2026-11-05): kept in an
 * app-store atom for the account, so a remount of the dialog (a variant
 * that lands late, a list refresh under it) never loses a tap.
 */

import { atom } from "jotai";

import type { Device } from "@/components/steps/makeControls";

export interface WelcomePicks {
  uid: string | null;
  /** null: nothing tapped yet (the saved or the app's answer shows) */
  picked: Device[] | null;
}

export const EMPTY_WELCOME_PICKS: WelcomePicks = { uid: null, picked: null };

export const welcomePicksAtom = atom<WelcomePicks>(EMPTY_WELCOME_PICKS);
