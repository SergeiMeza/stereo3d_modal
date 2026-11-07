"use client";

/**
 * The live status stream for the whole signed-in session (owner
 * 2026-11-07): mounted once in the layout, it keeps the one stream open
 * while someone is signed in and forgets everything live at sign-out.
 * Renders nothing.
 */

import { useEffect } from "react";

import { useAuth } from "@/lib/auth";
import { stopLive } from "@/lib/live/hub";
import { useLiveFeed } from "@/lib/live/useLive";

export function LiveEvents(): null {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  useLiveFeed();
  useEffect(() => {
    if (uid === null) stopLive();
  }, [uid]);
  return null;
}
