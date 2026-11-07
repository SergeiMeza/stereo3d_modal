/**
 * Runs as the live feed knows them (owner 2026-11-07): the atoms are the
 * live store's (lib/live/liveStore, app store), fed by the status stream,
 * its slow poll and the answers to actions. Read them with
 * lib/live/useLive; kept here for the names older code and tests use.
 */

import { resetLiveHubForTests } from "@/lib/live/hub";
import { resetLive, runAtom } from "@/lib/live/liveStore";
import { appStore } from "@/lib/state/stores";

/** One run as the live feed last knew it (null until it said anything). */
export const conversionAtom = runAtom;

/** Test hook: close the stream and forget every live run and project. */
export function resetConversionsForTests(): void {
  resetLiveHubForTests();
  resetLive(appStore);
}
