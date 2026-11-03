"use client";

/**
 * Right side of the sticky header — the client island inside the server
 * layout. Signed out (firebase mode): a "Sign in" link. Signed in (or mock
 * mode, whose fixed user looks signed in): the avatar + truncated email
 * opens the account menu — Account, Billing (S3D-57), Sign out. Renders
 * nothing while the session is being restored so the header never
 * flashes the wrong state.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { UserAvatar } from "@/components/auth/UserAvatar";
import { useAuth } from "@/lib/auth";

export function UserMenu() {
  const { user, ready, signOutUser } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!ready) return null;

  if (user === null) {
    return (
      <Link
        href="/signin"
        className="ml-auto rounded-md border border-edge px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-primary/60 hover:text-fg"
      >
        Sign in
      </Link>
    );
  }

  const item =
    "block rounded-md px-3 py-1.5 text-left text-sm text-fg hover:bg-surface-2";
  return (
    <div ref={ref} className="relative ml-auto min-w-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-fg-muted transition-colors hover:text-fg"
      >
        <UserAvatar photoURL={user.photoURL} name={user.displayName ?? user.email} />
        <span className="hidden max-w-40 truncate text-xs sm:block">
          {user.email ?? user.displayName ?? "Account"}
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          data-testid="account-menu"
          className="absolute top-full right-0 z-50 mt-1 flex w-56 flex-col gap-0.5 rounded-lg border border-edge bg-popover p-1.5 shadow-lg"
        >
          <p className="truncate px-3 py-1.5 text-xs text-fg-muted">
            {user.email ?? user.displayName}
          </p>
          <Link role="menuitem" href="/account" className={item} onClick={() => setOpen(false)}>
            Account
          </Link>
          <Link
            role="menuitem"
            href="/account/billing"
            className={item}
            onClick={() => setOpen(false)}
          >
            Billing
          </Link>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={async () => {
              setOpen(false);
              await signOutUser();
              router.replace("/");
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
