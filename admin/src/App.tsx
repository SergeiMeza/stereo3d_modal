import { useEffect, useState, useSyncExternalStore } from "react";

import { Brand } from "./components/Brand";
import { DisputeBadge, DisputeDueBanner, useDisputeAlert } from "./components/DisputesAlert";
import { StateBox } from "./components/ui";
import type { AdminApi } from "./lib/api";
import type { AdminAuth } from "./lib/auth";
import { Link, RouterProvider, paths, useRouter } from "./lib/router";
import { ServicesProvider, useServices } from "./lib/services";
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
  // ready: Google with the authenticator code; passkey: Google, then the
  // passkey session (ADR 0135).
  const signedIn = state.kind === "ready" || (state.kind === "passkey" && session !== null);
  if (!signedIn) return <SignInScreen auth={auth} state={state} api={api} />;
  return (
    <ServicesProvider api={api} auth={auth} email={state.email}>
      <RouterProvider initialPath={initialPath}>
        <Shell />
      </RouterProvider>
    </ServicesProvider>
  );
}

function Shell() {
  const { route } = useRouter();
  const { auth, email } = useServices();
  const [openCount, setOpenCount] = useState<number | null>(null);
  const disputeAlert = useDisputeAlert();
  const tab = (name: string, to: string, label: string, extra?: React.ReactNode) => (
    <Link to={to} className={route.name === name || route.name === name.replace(/s$/, "") ? "on" : ""}>
      {label}
      {extra}
    </Link>
  );
  return (
    <>
      <header className="ah">
        <Link to={paths.cases()} aria-label="Cases">
          <Brand env={ENV} />
        </Link>
        <nav aria-label="Sections">
          {tab("cases", paths.cases(), "Cases", openCount !== null && <span className="cnt">{openCount}</span>)}
          {tab("disputes", paths.disputes(), "Disputes and fraud")}
          {tab("onboarding", paths.onboarding(), "Onboarding")}
          {tab("plans", paths.plans(), "Plans surfaces")}
          {tab("feedback", paths.feedback(), "Feedback")}
          {tab("accounts", paths.accounts(), "Accounts")}
          {tab("mails", paths.mails(), "Mail previews")}
          {tab("policy", paths.policy(), "Refund policy")}
          {tab("security", paths.security(), "Security")}
        </nav>
        <span className="grow" />
        <DisputeBadge alert={disputeAlert} />
        <span className="muted small">MFA on</span>
        <span className="avatar" title={email} aria-label={email}>
          {(email[0] ?? "A").toUpperCase()}
        </span>
        <button type="button" className="btn ghost sm" onClick={() => void auth.signOut()}>
          Sign out
        </button>
      </header>
      <main className="a-main">
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
            <Link to={paths.cases()} className="link">Back to cases</Link>
          </StateBox>
        )}
      </main>
    </>
  );
}
