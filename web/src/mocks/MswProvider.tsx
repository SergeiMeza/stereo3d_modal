"use client";

import { useEffect, useState } from "react";

const mockEnabled = process.env.NEXT_PUBLIC_API_MOCK === "1";

/** Starts the MSW worker before rendering children so no request races the
 * mock gateway. No-op (renders immediately) when mocking is off. */
export function MswProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(!mockEnabled);

  useEffect(() => {
    if (!mockEnabled) return;
    let cancelled = false;
    import("@/mocks/browser").then(({ worker }) =>
      worker
        .start({ onUnhandledRequest: "bypass" })
        .then(() => !cancelled && setReady(true)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex h-40 items-center justify-center text-fg-muted">
        starting mock gateway…
      </div>
    );
  }
  return <>{children}</>;
}
