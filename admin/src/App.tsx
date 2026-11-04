import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";

import { Brand } from "./components/Brand";
import { StateBox } from "./components/common";
import { DisputeBadge, DisputeDueBanner, useDisputeAlert } from "./components/DisputesAlert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Toaster } from "./components/ui/sonner";
import type { AdminApi } from "./lib/api";
import type { AdminAuth } from "./lib/auth";
import { Link, RouterProvider, paths, useRouter } from "./lib/router";
import { ServicesProvider, useServices } from "./lib/services";
import { cn } from "./lib/utils";
import { AccountLookup, AccountPage } from "./screens/AccountPage";
import { CasePage } from "./screens/CasePage";
import { CasesList } from "./screens/CasesList";
import { DisputesPanel } from "./screens/Disputes";
import { OnboardingPanel } from "./screens/Onboarding";
import { PlansSurfacesPanel } from "./screens/PlansSurfaces";
import { FeedbackPanel } from "./screens/Feedback";
import { MailPreviews } from "./screens/MailPreviews";
import { PolicyPage } from "./screens/Policy";
import { SecurityPage } from "./screens/Security";
import { SignInScreen } from "./screens/SignIn";

const ENV = import.meta.env.VITE_ENV_LABEL as string | undefined;

export function App({ auth, api, initialPath }: { auth: AdminAuth; api: AdminApi; initialPath?: string }) {
  const state = useSyncExternalStore(auth.subscribe, auth.getState);
  const session = useSyncExternalStore(api.session.subscribe, api.session.get);
  // Signed out of Google: the passkey session goes too.
  useEffect(() => {
    if (state.kind === "signed_out" || state.kind === "no_access") api.session.clear();
  }, [state.kind, api]);
  // Signed in = Google with the claim, then the passkey session (ADR 0135).
  const signedIn = state.kind === "passkey" && session !== null;
  return (
    <>
      {signedIn ? (
        <ServicesProvider api={api} auth={auth} email={state.email}>
          <RouterProvider initialPath={initialPath}>
            <Shell />
          </RouterProvider>
        </ServicesProvider>
      ) : (
        <SignInScreen auth={auth} state={state} api={api} />
      )}
      <Toaster />
    </>
  );
}

function NavLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 whitespace-nowrap text-muted-foreground hover:text-foreground",
        active && "bg-secondary text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function Shell() {
  const { route, navigate } = useRouter();
  const { auth, email } = useServices();
  const [openCount, setOpenCount] = useState<number | null>(null);
  const disputeAlert = useDisputeAlert();
  const tab = (name: string, to: string, label: string, extra?: ReactNode) => (
    <NavLink to={to} active={route.name === name || route.name === name.replace(/s$/, "")}>
      {label}
      {extra}
    </NavLink>
  );
  return (
    <>
      <header className="sticky top-0 z-20 flex h-13 items-center gap-5 overflow-x-auto border-b border-border bg-card px-5 max-[1000px]:gap-3 max-[1000px]:px-3">
        <Link to={paths.cases()} aria-label="Cases" className="rounded-md">
          <Brand env={ENV} />
        </Link>
        <nav aria-label="Sections" className="flex gap-1 overflow-x-auto">
          {tab(
            "cases",
            paths.cases(),
            "Cases",
            openCount !== null && (
              <span className="rounded-full bg-primary/20 px-1.5 text-2xs leading-[17px] text-link tabular-nums">{openCount}</span>
            ),
          )}
          {tab("disputes", paths.disputes(), "Disputes and fraud")}
          {tab("onboarding", paths.onboarding(), "Onboarding")}
          {tab("plans", paths.plans(), "Plans surfaces")}
          {tab("feedback", paths.feedback(), "Feedback")}
          {tab("accounts", paths.accounts(), "Accounts")}
          {tab("mails", paths.mails(), "Mail previews")}
          {tab("policy", paths.policy(), "Refund policy")}
          {tab("security", paths.security(), "Security")}
        </nav>
        <span className="flex-1" />
        <DisputeBadge alert={disputeAlert} />
        <span className="text-sm whitespace-nowrap text-muted-foreground">Passkey on</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Account menu"
            className="inline-flex items-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="grid size-7 place-items-center rounded-full bg-info-bg text-xs font-semibold text-info-foreground" aria-hidden>
              {(email[0] ?? "A").toUpperCase()}
            </span>
            <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="max-w-64 truncate">{email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate(paths.security())}>Security and passkeys</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void auth.signOut()}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <main className="flex max-w-[1440px] flex-col gap-3.5 px-6 pt-5 pb-12 max-[1000px]:p-4">
        <DisputeDueBanner alert={disputeAlert} />
        {route.name === "cases" && <CasesList onCounts={(c) => setOpenCount(c.open)} />}
        {route.name === "case" && <CasePage id={route.id} key={route.id} />}
        {route.name === "accounts" && <AccountLookup />}
        {route.name === "account" && <AccountPage uid={route.uid} key={route.uid} />}
        {route.name === "disputes" && <DisputesPanel />}
        {route.name === "onboarding" && <OnboardingPanel />}
        {route.name === "plans" && <PlansSurfacesPanel />}
        {route.name === "feedback" && <FeedbackPanel />}
        {route.name === "mails" && <MailPreviews />}
        {route.name === "policy" && <PolicyPage />}
        {route.name === "security" && <SecurityPage />}
        {route.name === "not_found" && (
          <StateBox title="Nothing here.">
            <Link to={paths.cases()} className="text-link hover:underline">Back to cases</Link>
          </StateBox>
        )}
      </main>
    </>
  );
}
