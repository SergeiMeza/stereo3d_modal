/**
 * The project a project page's store belongs to (ADR 0138): set when
 * ProjectStateProvider creates the store; null in the app store.
 */

import { atom } from "jotai";

export const openProjectIdAtom = atom<string | null>(null);
