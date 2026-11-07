/**
 * Mail language (mail redesign): the account's mail_locale follows the web
 * language. Saved when a session starts with another language and when
 * the language changes; debounced, once per change; a gateway without the
 * field is ignored; `locale` (the Lifelike intro's language) is never sent.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthProvider, authStateAtom, resetAuthForTests } from "@/lib/auth";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import type { Locale } from "@/lib/i18n/locales";
import { appStore } from "@/lib/state/stores";
import { resetAccountSettingsCache } from "@/lib/useAccountSettings";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { MailLocaleSync, setMailLocaleDelayForTests } from "./MailLocaleSync";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

let patches: Record<string, unknown>[] = [];
let gets = 0;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  resetAccountSettingsCache();
  setMailLocaleDelayForTests(30);
  patches = [];
  gets = 0;
  server.events.on("request:start", async ({ request }) => {
    if (!request.url.endsWith("/v1/account/settings")) return;
    if (request.method === "PATCH") patches.push((await request.clone().json()) as Record<string, unknown>);
    if (request.method === "GET") gets++;
  });
});
afterEach(() => {
  cleanup();
  server.events.removeAllListeners();
  server.resetHandlers();
  mockDb.reset();
  resetAuthForTests();
  setMailLocaleDelayForTests(null);
});
afterAll(() => server.close());

function tree(locale: Locale): ReactNode {
  return (
    <I18nProvider locale={locale} messages={null}>
      <AuthProvider>
        <MailLocaleSync />
      </AuthProvider>
    </I18nProvider>
  );
}

const settle = () => new Promise((r) => setTimeout(r, 150));

describe("the mails' language follows the web's", () => {
  it("saves it when a signed-in session starts in another language, and only mail_locale", async () => {
    mockDb.accountSettings.locale = "ja";
    mockDb.accountSettings.mail_locale = "en";
    render(tree("de"));
    await waitFor(() => expect(patches).toEqual([{ mail_locale: "de" }]));
    expect(mockDb.accountSettings.mail_locale).toBe("de");
    // the Lifelike intro's language stays as it was
    expect(mockDb.accountSettings.locale).toBe("ja");
    await settle();
    expect(patches).toHaveLength(1);
  });

  it("sends nothing when the saved one is the same", async () => {
    mockDb.accountSettings.mail_locale = "fr";
    render(tree("fr"));
    await waitFor(() => expect(gets).toBe(1));
    await settle();
    expect(patches).toEqual([]);
  });

  it("saves a language change once, debounced to the last one", async () => {
    mockDb.accountSettings.mail_locale = "en";
    const view = render(tree("en"));
    await waitFor(() => expect(gets).toBe(1));
    await settle();
    expect(patches).toEqual([]);
    view.rerender(tree("de"));
    view.rerender(tree("ko"));
    await waitFor(() => expect(patches).toEqual([{ mail_locale: "ko" }]));
    await settle();
    expect(patches).toEqual([{ mail_locale: "ko" }]);
    for (const p of patches) expect(p).not.toHaveProperty("locale");
  });

  it("an older gateway without the field: no error, and no resend for the same language", async () => {
    server.use(
      // answers without mail_locale, as gateways before feat/mail-polish do
      http.get(`${GATEWAY}/v1/account/settings`, () =>
        HttpResponse.json({ lifelike_intro: true, lifelike_intro_editable: false, locale: null, hints_seen: [], onboarding: {}, dismissed: {} }),
      ),
      http.patch(`${GATEWAY}/v1/account/settings`, () =>
        HttpResponse.json({ error: { code: "invalid_request", message: "unknown field mail_locale" } }, { status: 400 }),
      ),
    );
    const view = render(tree("es"));
    await waitFor(() => expect(patches).toEqual([{ mail_locale: "es" }]));
    view.rerender(tree("es"));
    await settle();
    expect(patches).toHaveLength(1);
  });

  it("an older gateway that drops the field: one send, no loop", async () => {
    const old = { lifelike_intro: true, lifelike_intro_editable: false, locale: null, hints_seen: [], onboarding: {}, dismissed: {} };
    server.use(
      http.get(`${GATEWAY}/v1/account/settings`, () => HttpResponse.json(old)),
      // accepts the PATCH and answers without mail_locale, a moment later
      // (as over a network, so the page shows the change before the answer)
      http.patch(`${GATEWAY}/v1/account/settings`, async () => {
        await delay(40);
        return HttpResponse.json(old);
      }),
    );
    render(tree("tr"));
    await waitFor(() => expect(patches).toEqual([{ mail_locale: "tr" }]));
    await settle();
    await settle();
    expect(patches).toHaveLength(1);
  });

  it("nothing while signed out", async () => {
    appStore.set(authStateAtom, { ...appStore.get(authStateAtom), user: null });
    render(tree("de"));
    await settle();
    expect(patches).toEqual([]);
  });
});
