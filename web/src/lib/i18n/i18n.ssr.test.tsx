/**
 * Two requests rendered interleaved each keep their own language: the
 * translator is per request, never module state (owner 2026-11-07).
 *
 * Its own file (CI 2026-11-07): the server renderer and the client one
 * share the context's current value in one test realm, so a suspended
 * server render could leave its language for a client render in a later
 * test of the same file (never so in a real server or browser).
 */
import { renderToReadableStream } from "react-dom/server.browser";
import { Suspense, use } from "react";
import { describe, expect, it } from "vitest";

import { I18nProvider, useT } from "./I18nProvider";

describe("messages per request", () => {
  it("two requests rendered interleaved each keep their own language (no module state)", async () => {
    // each tree suspends halfway; the other renders while it waits
    const gate = (): { p: Promise<void>; open: () => void } => {
      let open!: () => void;
      const p = new Promise<void>((r) => (open = r));
      return { p, open };
    };
    const ja = gate();
    const de = gate();
    const Half = ({ wait }: { wait: Promise<void> }) => {
      use(wait);
      return <i>{useT()("common.language")}</i>;
    };
    const Page = ({ wait }: { wait: Promise<void> }) => (
      <p>
        <b>{useT()("common.language")}</b>
        <Suspense fallback="…">
          <Half wait={wait} />
        </Suspense>
      </p>
    );
    const html = async (s: ReadableStream<Uint8Array>) => new Response(s).text();
    const a = await renderToReadableStream(
      <I18nProvider locale="ja" messages={{ common: { language: "言語" } }}>
        <Page wait={ja.p} />
      </I18nProvider>,
    );
    const b = await renderToReadableStream(
      <I18nProvider locale="de" messages={{ common: { language: "Sprache" } }}>
        <Page wait={de.p} />
      </I18nProvider>,
    );
    const outA = html(a);
    const outB = html(b);
    de.open();
    await new Promise((r) => setTimeout(r, 0));
    ja.open();
    const [ha, hb] = await Promise.all([outA, outB]);
    expect(ha).toContain("<b>言語</b>");
    expect(ha).toContain("<i>言語</i>");
    expect(ha).not.toContain("Sprache");
    expect(hb).toContain("<b>Sprache</b>");
    expect(hb).toContain("<i>Sprache</i>");
    expect(hb).not.toContain("言語");
  });
});
