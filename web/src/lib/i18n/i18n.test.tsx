/**
 * The web app's languages (owner 2026-11-07): picking one, English per key
 * when a language lacks it, ICU plurals, the formatters, and every key the
 * code names existing in English.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatCents, formatCentsShort } from "@/components/steps/money";
import en from "../../../messages/en.json";

import { renderToReadableStream } from "react-dom/server.browser";
import { Suspense, use } from "react";

import { I18nProvider, useT } from "./I18nProvider";
import { LanguagePicker } from "./LanguagePicker";
import { dirOf, fromAcceptLanguage, LOCALES, matchTag, resolveLocale } from "./locales";
import { rich } from "./rich";
import { EN, hasKey, makeTr, translate } from "./t";

afterEach(() => {
  cleanup();
  document.cookie = "NEXT_LOCALE=; path=/; max-age=0";
});

describe("picking the language", () => {
  it("the cookie first, then Accept-Language, then English", () => {
    expect(resolveLocale("ja", "de-DE,de;q=0.9")).toBe("ja");
    expect(resolveLocale(undefined, "de-AT,de;q=0.9,en;q=0.5")).toBe("de");
    expect(resolveLocale("xx", "pt-BR,pt;q=0.9")).toBe("en");
    expect(resolveLocale(null, null)).toBe("en");
    expect(fromAcceptLanguage("fr;q=0.2, ko;q=0.8")).toBe("ko");
  });

  it("Chinese by script and region", () => {
    expect(matchTag("zh-TW")).toBe("zh-Hant");
    expect(matchTag("zh-Hant-HK")).toBe("zh-Hant");
    expect(matchTag("zh-CN")).toBe("zh-Hans");
    expect(matchTag("zh")).toBe("zh-Hans");
    expect(matchTag("es-MX")).toBe("es");
  });

  it("the site's order, each in its own name; Arabic right to left", () => {
    expect(LOCALES.map((l) => l.code)).toEqual(["en", "zh-Hans", "ja", "fr", "de", "zh-Hant", "ko", "es", "ru", "tr", "ar"]);
    expect(LOCALES.map((l) => l.name)).toEqual([
      "English", "简体中文", "日本語", "Français", "Deutsch", "繁體中文", "한국어", "Español", "Русский", "Türkçe", "العربية",
    ]);
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("ja")).toBe("ltr");
  });

  it("the picker sets NEXT_LOCALE and reloads", () => {
    const onPick = vi.fn();
    render(<LanguagePicker onPick={onPick} />);
    fireEvent.change(screen.getByTestId("language-picker"), { target: { value: "de" } });
    expect(onPick).toHaveBeenCalledWith("de");
    expect(document.cookie).toContain("NEXT_LOCALE=de");
  });
});

describe("messages", () => {
  it("a language's own message, English for a key it lacks, never the key", () => {
    const ja = { common: { language: "言語" } };
    expect(translate("ja", ja, "common.language")).toBe("言語");
    expect(translate("ja", {}, "common.language")).toBe("Language");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(translate("ja", ja, "nope.missing")).toBe("");
    err.mockRestore();
  });

  it("ICU plurals and values", () => {
    const msgs = { x: { runs: "{count, plural, one {# run} other {# runs}}", hi: "Hi {name}" } };
    expect(translate("de", msgs, "x.runs", { count: 1 })).toBe("1 run");
    expect(translate("de", msgs, "x.runs", { count: 3 })).toBe("3 runs");
    // Japanese has one form
    expect(translate("ja", msgs, "x.runs", { count: 1 })).toBe("1 runs");
    expect(translate("ja", msgs, "x.hi", { name: "Kim" })).toBe("Hi Kim");
  });

  it("a broken translation reads in English", () => {
    expect(translate("ja", { common: { language: "{oops" } }, "common.language")).toBe("Language");
  });

  it("the provider gives its tree its translator; outside one it's English", () => {
    const Label = () => <span data-testid="l">{useT()("common.language")}</span>;
    render(
      <>
        <I18nProvider locale="ja" messages={{ common: { language: "言語" } }}>
          <Label />
        </I18nProvider>
        <Label />
      </>,
    );
    expect(screen.getAllByTestId("l").map((e) => e.textContent)).toEqual(["言語", "Language"]);
  });

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

describe("rich messages", () => {
  it("tags wrap their text; the language's own message, else English", () => {
    const Rich = ({ tr }: { tr: ReturnType<typeof makeTr> }) => (
      <p data-testid="r">{rich(tr, "common.richExample", { b: (c) => <strong>{c}</strong> }, { name: "Kim" })}</p>
    );
    render(<Rich tr={EN} />);
    expect(screen.getByTestId("r").innerHTML).toBe("Hello <strong>Kim</strong>");
    cleanup();
    render(<Rich tr={makeTr("de", { common: { richExample: "Hallo <b>{name}</b>!" } })} />);
    expect(screen.getByTestId("r").innerHTML).toBe("Hallo <strong>Kim</strong>!");
  });
});

describe("formatters follow the language; USD stays", () => {
  it("English as before (and without a translator)", () => {
    expect(formatCents(150000)).toBe("$1,500.00");
    expect(formatCents(-50)).toBe("−$0.50");
    expect(formatCentsShort(2500)).toBe("$25");
    expect(formatCents(150000, EN)).toBe("$1,500.00");
  });

  it("German writes USD its own way", () => {
    const de = makeTr("de", null);
    expect(formatCents(150000, de)).toMatch(/^1\.500,00\s\$$/);
    expect(formatCentsShort(2500, de)).toMatch(/^25\s\$$/);
    expect(formatCents(-50, de)).toMatch(/^−0,50\s\$$/);
  });
});

/** Every t("…") literal under src names an English message. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("en.json", () => {
  it("has every key the code uses", () => {
    const missing: string[] = [];
    // lib/i18n's own comments hold examples
    for (const file of sources(join(__dirname, "..", "..")).filter((f) => !f.includes("/lib/i18n/"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\b(?:t|tr|rich\(\s*\w+\s*,)\(?\s*"([a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)"/g)) {
        if (!hasKey(m[1])) missing.push(`${file.split("/src/")[1]}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("is valid ICU throughout", async () => {
    const { IntlMessageFormat } = await import("intl-messageformat");
    const bad: string[] = [];
    const walk = (o: Record<string, unknown>, path: string) => {
      for (const [k, v] of Object.entries(o)) {
        const key = path ? `${path}.${k}` : k;
        if (typeof v === "string") {
          try {
            new IntlMessageFormat(v, "en-US", undefined, { ignoreTag: true });
          } catch {
            bad.push(key);
          }
        } else walk(v as Record<string, unknown>, key);
      }
    };
    walk(en as Record<string, unknown>, "");
    expect(bad).toEqual([]);
  });
});
