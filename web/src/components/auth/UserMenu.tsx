"use client";

/**
 * Right side of the sticky header — the client island inside the server
 * layout. Signed out (firebase mode): a "Sign in" link. Signed in (or mock
 * mode, whose fixed user looks signed in): a link to /account with avatar +
 * truncated email. Renders nothing while the session is being restored so
 * the header never flashes the wrong state.
 */

import Link from "next/link";

import { UserAvatar } from "@/components/auth/UserAvatar";
import { useAuth } from "@/lib/auth";

export function UserMenu() {
  const { user, ready } = useAuth();

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

  return (
    <Link
      href="/account"
      className="ml-auto flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-fg-muted transition-colors hover:text-fg"
    >
      <UserAvatar photoURL={user.photoURL} name={user.displayName ?? user.email} />
      <span className="max-w-40 truncate text-xs">
        {user.email ?? user.displayName ?? "Account"}
      </span>
    </Link>
  );
}
