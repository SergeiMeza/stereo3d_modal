"use client";

/**
 * Right side of the sticky header — the client island inside the server
 * layout. Signed out (firebase mode): a "Sign in" link. Signed in (or mock
 * mode, whose fixed user looks signed in): the avatar + truncated email
 * opens the account menu — Account, Plan & billing, Sign out (owner
 * 2026-11-05: one entry for the plan and the money; Pro and every other
 * plan are on /plans, linked from there). Renders
 * nothing while the session is being restored so the header never
 * flashes the wrong state.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";

import { UserAvatar } from "@/components/auth/UserAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth";

export function UserMenu() {
  const { user, ready, signOutUser } = useAuth();
  const router = useRouter();

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
    <div className="ml-auto min-w-0">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-fg-muted transition-colors hover:text-fg"
          >
            <UserAvatar
              photoURL={user.photoURL}
              name={user.displayName ?? user.email}
            />
            <span className="hidden max-w-40 truncate text-xs sm:block">
              {user.email ?? user.displayName ?? "Account"}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          data-testid="account-menu"
          className="w-56"
        >
          <DropdownMenuLabel className="truncate">
            {user.email ?? user.displayName}
          </DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link href="/account">Account</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/account/billing">Plan &amp; billing</Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={async () => {
              await signOutUser();
              router.replace("/");
            }}
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
