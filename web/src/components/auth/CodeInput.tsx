"use client";

/**
 * Six-digit code entry (S3D-70). One real <input> sits over six slots, so
 * every keyboard works the same: a headset's virtual keyboard, a phone's
 * one-time-code autofill, paste ("123 456", "Your code: 123456"), and
 * backspace. The slots only draw what the input holds. onComplete fires as
 * the sixth digit lands (auto-advance).
 */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { CODE_LENGTH, codeDigits } from "@/lib/emailCode";
import { useT } from "@/lib/i18n/I18nProvider";
import { cn } from "@/lib/utils";

export function CodeInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  autoFocus = true,
}: {
  value: string;
  onChange: (digits: string) => void;
  onComplete: (digits: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
}): JSX.Element {
  const t = useT();
  const ref = useRef<HTMLInputElement | null>(null);
  const [hasFocus, setHasFocus] = useState(false);

  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus();
  }, [autoFocus, disabled]);

  function take(raw: string) {
    const digits = codeDigits(raw);
    onChange(digits);
    if (digits.length === CODE_LENGTH && digits !== value) onComplete(digits);
  }

  const active = Math.min(value.length, CODE_LENGTH - 1);
  return (
    <div className="relative" data-testid="code-input">
      <input
        ref={ref}
        aria-label={t("auth.code.inputLabel")}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        enterKeyHint="go"
        spellCheck={false}
        disabled={disabled}
        value={value}
        onChange={(e) => take(e.target.value)}
        onFocus={() => setHasFocus(true)}
        onBlur={() => setHasFocus(false)}
        onPaste={(e) => {
          e.preventDefault();
          take(e.clipboardData.getData("text"));
        }}
        className="absolute inset-0 z-10 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 outline-none selection:bg-transparent"
      />
      <div className="grid grid-cols-6 gap-2" aria-hidden="true">
        {Array.from({ length: CODE_LENGTH }, (_, i) => {
          const digit = value[i] ?? "";
          const focused =
            hasFocus && !disabled && i === active && value.length < CODE_LENGTH;
          return (
            <div
              key={i}
              className={cn(
                "flex h-14 items-center justify-center rounded-lg border bg-surface-2 font-mono text-2xl font-semibold tabular-nums text-fg transition-colors",
                invalid
                  ? "border-destructive/70"
                  : focused
                    ? "border-primary ring-2 ring-primary/25"
                    : digit
                      ? "border-primary/40"
                      : "border-edge",
                disabled && "opacity-60",
              )}
            >
              {digit}
            </div>
          );
        })}
      </div>
    </div>
  );
}
