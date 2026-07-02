"use client";

/**
 * Auth guard for signed-in-only pages (projects list, workspace, account).
 * In mock mode the context is ready with a fixed user, so children render
 * immediately. In firebase mode: a muted placeholder while the SDK restores
 * the session, then a replace-redirect to /signin (carrying ?next= back to
 * the guarded path) when nobody is signed in — replace, not push, so Back
 * doesn't bounce through the guard.
 *
 * Also ensures the billing profile (POST /v1/customers, idempotent) once
 * per signed-in user: conversion creation hard-fails on the gateway with
 * "no billing profile" otherwise. Fire-and-forget — a failure here must
 * never block the UI; the pre-project-create ensure is the backstop.
 */

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";

/** uids whose billing profile was ensured this page load (module scope —
 * one POST per user per session, not per guarded mount). */
const ensuredBillingUids = new Set<string>();

/** Test hook — clears the once-per-session memo. */
export function resetEnsuredBillingProfiles(): void {
  ensuredBillingUids.clear();
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const gateway = useGateway();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (ready && user === null) {
      router.replace(`/signin?next=${encodeURIComponent(pathname)}`);
    }
  }, [ready, user, router, pathname]);

  useEffect(() => {
    if (!ready || user === null || ensuredBillingUids.has(user.uid)) return;
    ensuredBillingUids.add(user.uid);
    gateway.ensureCustomer().catch((e: unknown) => {
      // Allow a retry on the next guarded mount rather than never again.
      ensuredBillingUids.delete(user.uid);
      console.warn("billing profile ensure failed", e);
    });
  }, [ready, user, gateway]);

  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center py-24 text-fg-muted">
        Checking session…
      </div>
    );
  }
  if (user === null) return null;
  return <>{children}</>;
}
