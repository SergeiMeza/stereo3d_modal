"use client";

/**
 * Auth guard for signed-in-only pages (projects list, workspace, account).
 * In mock mode the context is ready with a fixed user, so children render
 * immediately. In firebase mode: a muted placeholder while the SDK restores
 * the session, then a replace-redirect to /signin (carrying ?next= back to
 * the guarded path) when nobody is signed in — replace, not push, so Back
 * doesn't bounce through the guard.
 */

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/lib/auth";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (ready && user === null) {
      router.replace(`/signin?next=${encodeURIComponent(pathname)}`);
    }
  }, [ready, user, router, pathname]);

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
