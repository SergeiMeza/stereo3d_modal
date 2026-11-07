# Web app messages (stereo3d.studio)

`en.json` holds every customer-facing string of the web app, by namespaced
key (`billing.history.title`). Each language is one file beside it with the
same keys: `zh-Hans.json`, `ja.json`, `fr.json`, `de.json`, `zh-Hant.json`,
`ko.json`, `es.json`, `ru.json`, `tr.json`, `ar.json`.

A key a language leaves out reads in English, so a partial file is safe.
After adding a file, register it in `src/lib/i18n/catalogs.ts`:

```ts
import ja from "../../../messages/ja.json";
// …
const CATALOGS = { en, ja, /* … */ };
```

Then run `npx vitest run src/lib/i18n` (it checks every message parses).

## Brief for translators

- **Same tone as the Spatial Video Studio app**: short, plain, friendly,
  second person. Say what happens, not how it works. No marketing filler.
- **Credit and price copy stays short.** Buttons, badges and price lines
  sit in tight spaces ("Make 3D · $12.00", "−25% launch offer"). Keep them
  as short as the English, or shorter.
- **Never translate product names**: Spatial Video Studio, Lifelike 3D,
  Classic 3D, Pro, Business, Studio, and the File quality names Standard,
  High and Master. Most of them come in as placeholders; when one is
  written in a message, copy it as is.
- **"Spatial" is Apple's localized word**, as on Apple Vision Pro in that
  language (ja 空間, zh-Hans 空间, zh-Hant 空間, de räumlich/Raum-, fr
  spatial, es espacial, ko 공간, ru пространственный, tr uzamsal, ar مكاني).
  Use Apple's own term for "spatial video" / "spatial photo" there.
- **Keep every placeholder exactly**: `{name}`, `{price}`, `{count}`, `#`.
  Don't translate what's inside the braces, don't drop one, don't add one.
- **ICU plurals**: `{count, plural, one {# run} other {# runs}}`. Keep the
  structure and give the categories your language needs (`zero`, `one`,
  `two`, `few`, `many`, `other`; `other` is always required). Japanese,
  Chinese, Korean and Turkish only need `other`; Russian and Arabic need
  more forms.
- **Brand and device names stay as written**: Apple Vision Pro, Meta Quest,
  Pico, Galaxy XR, Steam Frame, iPhone, Mac.
- **Amounts, sizes and resolutions** (1080p, 4K, 3840×2160, 24 fps, $12.00)
  come in as placeholders and are formatted for the language by the app.
- **Arabic** reads right to left; the app mirrors its layout. Write it
  naturally; don't add direction marks around placeholders.
- Legal pages (/terms, /privacy) are not in these files and stay English.
