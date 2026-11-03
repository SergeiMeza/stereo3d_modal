import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

/** A tiny history router: the console has six routes. */

export type Route =
  | { name: "cases" }
  | { name: "case"; id: string }
  | { name: "accounts" }
  | { name: "account"; uid: string }
  | { name: "disputes" }
  | { name: "mails" }
  | { name: "policy" }
  | { name: "not_found" };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: "cases" };
  const [a, b] = parts;
  if (a === "cases" && parts.length === 1) return { name: "cases" };
  if (a === "cases" && parts.length === 2 && b) return { name: "case", id: b };
  if (a === "accounts" && parts.length === 1) return { name: "accounts" };
  if (a === "accounts" && parts.length === 2 && b) return { name: "account", uid: b };
  if (a === "disputes" && parts.length === 1) return { name: "disputes" };
  if (a === "mails" && parts.length === 1) return { name: "mails" };
  if (a === "policy" && parts.length === 1) return { name: "policy" };
  return { name: "not_found" };
}

export const paths = {
  cases: () => "/cases",
  case: (id: string) => `/cases/${encodeURIComponent(id)}`,
  accounts: () => "/accounts",
  account: (uid: string) => `/accounts/${encodeURIComponent(uid)}`,
  disputes: () => "/disputes",
  mails: () => "/mails",
  policy: () => "/policy",
};

interface RouterValue {
  route: Route;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({
  children,
  initialPath,
}: {
  children: ReactNode;
  initialPath?: string;
}) {
  const [path, setPath] = useState(
    () => initialPath ?? window.location.pathname,
  );
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to !== window.location.pathname) window.history.pushState(null, "", to);
    setPath(to);
    window.scrollTo?.(0, 0);
  }, []);
  const value = useMemo(() => ({ route: parseRoute(path), navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const v = useContext(RouterContext);
  if (!v) throw new Error("useRouter outside RouterProvider");
  return v;
}

export function Link({
  to,
  children,
  onClick: onClickProp,
  ...rest
}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRouter();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClickProp?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} {...rest} onClick={onClick}>
      {children}
    </a>
  );
}
