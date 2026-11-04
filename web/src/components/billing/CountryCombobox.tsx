"use client";

/**
 * The billing address country (owner 2026-11-04: customers worldwide): a
 * searchable list of every country Stripe Checkout offers, named in the
 * page's language. Typing filters by name or by code; the person's own
 * country (where they are, else their browser's language) comes first.
 * Keyboard: the trigger opens with Enter/Space/arrows, arrows move, Enter
 * picks, Escape closes. A hidden autocomplete="country" field still takes
 * the browser's address autofill and picks the country it names.
 */

import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { countryFromText, countryName, countryOptions, isCountryCode, localeCountry, pageLocale } from "@/lib/company";

/** Where the visitor is (GET /api/geo, Vercel's header), else the browser
 * language's country. */
export function useDetectedCountry(): string | null {
  const [geo, setGeo] = useState<string | null>(null);
  const [fromLocale] = useState(localeCountry);
  useEffect(() => {
    let live = true;
    fetch("/api/geo")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { country?: string | null } | null) => {
        if (live && isCountryCode(j?.country)) setGeo(j.country.toUpperCase());
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return geo ?? fromLocale;
}

export function CountryCombobox({
  id,
  value,
  onChange,
  detected,
}: {
  id: string;
  value: string;
  onChange: (code: string) => void;
  detected: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const locale = pageLocale();
  const { first, rest } = useMemo(() => countryOptions(locale, detected), [locale, detected]);
  const listId = `${id}-list`;

  const item = ([code, name]: [string, string]) => (
    <CommandItem
      key={code}
      value={code}
      keywords={[name, code]}
      onSelect={() => {
        onChange(code);
        setOpen(false);
      }}
      data-testid={`country-${code}`}
    >
      <Check className={value === code ? "opacity-100" : "opacity-0"} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="text-xs text-fg-muted">{code}</span>
    </CommandItem>
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-haspopup="listbox"
            className="h-9 w-full justify-between font-normal"
            data-testid="company-country"
          >
            <span className="truncate">{countryName(value, locale)}</span>
            <ChevronsUpDown className="opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-32px)] min-w-64 p-0">
          {/* label: cmdk names its input through aria-labelledby */}
          <Command label="Search countries">
            <CommandInput placeholder="Search countries" />
            <CommandList id={listId}>
              <CommandEmpty>No country found.</CommandEmpty>
              {first !== null && (
                <>
                  <CommandGroup heading="Your country">{item(first)}</CommandGroup>
                  <CommandSeparator />
                </>
              )}
              <CommandGroup heading={first !== null ? "All countries" : undefined}>{rest.map(item)}</CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {/* the browser's address autofill fills this; it picks the country */}
      <input
        type="text"
        name="country"
        autoComplete="country"
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        value=""
        onChange={(e) => {
          const code = countryFromText(e.target.value, locale);
          if (code) onChange(code);
        }}
      />
    </>
  );
}
