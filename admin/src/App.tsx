import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Provider } from "jotai";
import { useHydrateAtoms } from "jotai/utils";
import { ChevronDownIcon, MenuIcon } from "lucide-react";

import { Brand } from "./components/Brand";
import { CommandMenu, SearchButton, useCommandShortcut, useOpenSearch } from "./components/CommandMenu";
import { StateBox } from "./components/common";
import { DisputeDueBanner } from "./components/DisputesAlert";
import { NavList, PAGE_TITLES } from "./components/Nav";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./components/ui/sheet";
import { Toaster } from "./components/ui/sonner";
import type { AdminApi } from "./lib/api";
import { useAttention, useAttentionPolling } from "./lib/attention";
import type { AdminAuth } from "./lib/auth";
import { servicesAtom, type Services } from "./state/services";
import { Link, RouterProvider, paths, useRouter } from "./lib/router";
import { ReauthHost, useServices } from "./lib/services";
import { AccountLookup, AccountPage } from "./screens/AccountPage";
import { CasePage } from "./screens/CasePage";
import { CasesList } from "./screens/CasesList";
import { DisputesPanel } from "./screens/Disputes";
import { FeedbackPanel } from "./screens/Feedback";
import { GrantsPage } from "./screens/GrantsPage";
import { MailPreviews } from "./screens/MailPreviews";
import { OnboardingPanel } from "./screens/Onboarding";
import { OverviewPage } from "./screens/Overview";
import { PlansSurfacesPanel } from "./screens/PlansSurfaces";
import { PolicyPage } from "./screens/Policy";
import { SecurityPage } from "./screens/Security";
import { SignInScreen } from "./screens/SignIn";

const ENV = import.meta.env.VITE_ENV_LABEL as string | undefined;

/** Sets the services atom once per store (ADR 0138). */
function HydrateServices({ services, children }: { services: Services; children: ReactNode }) {
  useHydrateAtoms([[servicesAtom, services]]);
  return children;
}

export function App({ auth, api, initialPath }: { auth: AdminAuth; api: AdminApi; initialPath?: string }) {
  const state = useSyncExternalStore(auth.subscribe, auth.getState);
  const session = useSyncExternalStore(api.session.subscribe, api.session.get);
  // Signed out of Google: the passkey session goes too.
  useEffect(() => {
    if (state.kind === "signed_out" || state.kind === "no_access") api.session.clear();
  }, [state.kind, api]);
  // Signed in = Google with the claim, then the passkey session (ADR 0135).
  const signedIn = state.kind === "passkey" && session !== null;
  const email = state.kind === "passkey" ? state.email : "";
  // One jotai store per signed-in session (ADR 0138): signing out, or in as
  // someone else, starts from empty atoms, so no server data carries over.
  return (
    <>
      <Provider key={signedIn ? `in:${email}` : "out"}>
        <HydrateServices services={{ api, auth, email }}>
          {signedIn ? (
            <RouterProvider initialPath={initialPath}>
              <Shell />
            </RouterProvider>
          ) : (
            <SignInScreen auth={auth} state={state} api={api} />
          )}
        </HydrateServices>
      </Provider>
      <Toaster />
    </>
  );
}

function AccountMenu() {
  const { auth, email } = useServices();
  const { navigate } = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="inline-flex h-9 items-center gap-1 rounded-full px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  );
}

function Shell() {
  const { route } = useRouter();
  useAttentionPolling();
  const attention = useAttention();
  const [menuOpen, setMenuOpen] = useState(false);
  const openSearch = useOpenSearch();
  const openEmptySearch = useCallback(() => openSearch(), [openSearch]);
  useCommandShortcut(openEmptySearch);
  const title = PAGE_TITLES[route.name] ?? "Admin";
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 flex h-13 items-center gap-4 border-b border-border bg-card px-5 max-md:h-16 max-md:gap-1.5 max-md:px-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-11 md:hidden"
          aria-label="Menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <MenuIcon className="size-5" />
        </Button>
        <Link to={paths.overview()} aria-label="Needs attention" className="rounded-md max-md:hidden">
          <Brand env={ENV} />
        </Link>
        <span className="flex-1 truncate text-[17px] font-semibold md:hidden" aria-hidden="true">
          {title}
        </span>
        <div className="flex flex-1 justify-center max-md:hidden">
          <SearchButton onClick={openEmptySearch} />
        </div>
        <span className="md:hidden">
          <SearchButton compact onClick={openEmptySearch} />
        </span>
        <span className="text-sm whitespace-nowrap text-muted-foreground max-lg:hidden">Signed in with a passkey</span>
        <AccountMenu />
      </header>
      <div className="flex flex-1">
        <aside className="sticky top-13 h-[calc(100dvh-52px)] w-55 shrink-0 overflow-y-auto border-r border-border bg-card px-2.5 py-3.5 max-md:hidden">
          <NavList route={route} />
        </aside>
        <main className="flex min-w-0 max-w-[1440px] flex-1 flex-col gap-4 px-7 pt-5.5 pb-12 max-md:px-4 max-md:pt-4">
          <DisputeDueBanner alert={attention.alert} />
          {route.name === "overview" && <OverviewPage />}
          {route.name === "cases" && <CasesList />}
          {route.name === "case" && <CasePage id={route.id} key={route.id} />}
          {route.name === "accounts" && <AccountLookup />}
          {route.name === "account" && <AccountPage uid={route.uid} key={route.uid} />}
          {route.name === "disputes" && <DisputesPanel />}
          {route.name === "grants" && <GrantsPage />}
          {route.name === "onboarding" && <OnboardingPanel />}
          {route.name === "plans" && <PlansSurfacesPanel />}
          {route.name === "feedback" && <FeedbackPanel />}
          {route.name === "mails" && <MailPreviews />}
          {route.name === "policy" && <PolicyPage />}
          {route.name === "security" && <SecurityPage />}
          {route.name === "not_found" && (
            <StateBox title="Nothing here.">
              <Link to={paths.overview()} className="text-link hover:underline">Back to what needs attention</Link>
            </StateBox>
          )}
        </main>
      </div>
      <ReauthHost />
      <CommandMenu />
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-[min(320px,85vw)] gap-3 overflow-y-auto px-3 pt-4 pb-6">
          <SheetTitle className="px-2">
            <Brand env={ENV} />
          </SheetTitle>
          <SheetDescription className="sr-only">Sections of the admin console</SheetDescription>
          <NavList route={route} big onNavigate={() => setMenuOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
