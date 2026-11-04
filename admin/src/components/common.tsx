import { useRef, type ReactNode } from "react";

import { safeExternalUrl } from "@/lib/links";
import { cn } from "@/lib/utils";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

/** The console's composites on top of components/ui. */

export type Tone = BadgeVariant;

/** A page's title row: the h1, an aside (counts, a note) and the tools on the right. */
export function PageHeader({ title, children, actions }: { title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4.5 gap-y-2">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children}
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A card with a header row: title, a muted note, and an action on the right. */
export function Panel({
  title,
  note,
  action,
  children,
  className,
  ...rest
}: {
  title?: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <Card className={className} {...rest}>
      {(title || note || action) && (
        <CardHeader>
          {title && <CardTitle className="text-sm">{title}</CardTitle>}
          {note && <CardDescription>{note}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      {children}
    </Card>
  );
}

/** A muted line inside a panel ("No cases."). */
export function EmptyRow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("px-4 py-3 text-xs text-muted-foreground", className)}>{children}</p>;
}

export function StateBox({
  tone = "muted",
  title,
  children,
  action,
}: {
  tone?: "muted" | "error";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center gap-2.5 rounded-xl bg-card px-4 py-10 text-center ring-1 ring-foreground/10"
      role={tone === "error" ? "alert" : undefined}
    >
      {tone === "error" && (
        <span
          className="grid size-9 place-items-center rounded-full border border-destructive/40 bg-destructive/10 font-bold text-destructive"
          aria-hidden="true"
        >
          !
        </span>
      )}
      <p className="font-medium">{title}</p>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ title, message, onRetry }: { title: string; message?: string; onRetry?: () => void }) {
  return (
    <StateBox tone="error" title={title} action={onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}>
      {message}
    </StateBox>
  );
}

export function Banner({ tone = "blue", children, action }: { tone?: "blue" | "amber" | "red"; children: ReactNode; action?: ReactNode }) {
  return (
    <Alert variant={tone}>
      <AlertDescription>{children}</AlertDescription>
      {action && <AlertAction>{action}</AlertAction>}
    </Alert>
  );
}

/** External link to an allowed host, else the text without a link. */
export function ExtLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  const safe = safeExternalUrl(href);
  if (!safe) return <span className="text-muted-foreground">{children}</span>;
  return (
    <a className="whitespace-nowrap text-link hover:underline" href={safe} target="_blank" rel="noopener noreferrer">
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

/** Customer-supplied or free text: plain text, line breaks kept, no links. */
export function PlainText({ text, inline = false, className }: { text: string | null | undefined; inline?: boolean; className?: string }) {
  return (
    <p className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", inline ? "inline text-inherit" : "text-foreground-2", className)}>
      {text ?? ""}
    </p>
  );
}

/** A list's loading state: skeleton rows in a card. */
export function SkeletonRows({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <Card aria-busy="true" aria-label="Loading">
      <Table>
        <TableBody>
          {Array.from({ length: rows }, (_, r) => (
            <TableRow key={r} data-testid="skeleton-row">
              {Array.from({ length: cols }, (_, c) => (
                <TableCell key={c}>
                  <Skeleton />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="grid place-items-center px-4 py-3">
      <Spinner label={label} />
    </div>
  );
}

/** A note under a control or in a sheet. */
export function Note({ tone = "muted", children, className }: { tone?: "muted" | "ok" | "error"; children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "text-sm",
        tone === "muted" && "text-muted-foreground",
        tone === "ok" && "text-success",
        tone === "error" && "text-destructive-foreground",
        className,
      )}
      role={tone === "error" ? "alert" : undefined}
    >
      {children}
    </p>
  );
}

/**
 * One modal for the console's forms and confirms:
 * - `alert`: AlertDialog, for money and anything that can't be undone.
 *   Outside clicks don't close it; focus starts on Cancel, or on the first
 *   field when there is one.
 * - `dialog`: a centred Dialog for short forms.
 * - `sheet`: a side Sheet for longer forms.
 * While `busy`, Esc, outside clicks and Cancel do nothing.
 */
export function Modal({
  kind = "dialog",
  title,
  subtitle,
  onClose,
  busy = false,
  wide = false,
  confirmLabel,
  onConfirm,
  confirmDisabled = false,
  confirmVariant = "default",
  cancelLabel = "Cancel",
  children,
}: {
  kind?: "dialog" | "alert" | "sheet";
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  confirmDisabled?: boolean;
  confirmVariant?: "default" | "destructive";
  cancelLabel?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onOpenChange = (open: boolean) => {
    if (!open && !busy) onClose();
  };
  const focusFirstField = (e: Event) => {
    const f = ref.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [role=combobox], [role=radio][data-state=checked]",
    );
    if (f) {
      e.preventDefault();
      f.focus();
    }
  };
  const blockWhileBusy = (e: Event) => {
    if (busy) e.preventDefault();
  };
  const confirm = (
    <Button variant={confirmVariant} size="lg" onClick={onConfirm} disabled={busy || confirmDisabled}>
      {confirmLabel}
    </Button>
  );
  const width = wide ? "sm:max-w-[620px]" : "sm:max-w-[460px]";
  const describedBy = subtitle ? {} : { "aria-describedby": undefined };

  if (kind === "alert") {
    return (
      <AlertDialog open onOpenChange={onOpenChange}>
        <AlertDialogContent
          ref={ref}
          className={cn("max-h-[calc(100dvh-32px)] overflow-y-auto", width)}
          onOpenAutoFocus={focusFirstField}
          onEscapeKeyDown={blockWhileBusy}
          {...describedBy}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {subtitle && <AlertDialogDescription className="text-[12.5px]">{subtitle}</AlertDialogDescription>}
          </AlertDialogHeader>
          <div className="flex min-w-0 flex-col gap-3">{children}</div>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-10 px-4" variant="ghost" disabled={busy}>
              {cancelLabel}
            </AlertDialogCancel>
            {confirm}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  const cancel = (
    <Button variant="ghost" size="lg" onClick={onClose} disabled={busy}>
      {cancelLabel}
    </Button>
  );

  if (kind === "sheet") {
    return (
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent
          ref={ref}
          closeDisabled={busy}
          onOpenAutoFocus={focusFirstField}
          onEscapeKeyDown={blockWhileBusy}
          onPointerDownOutside={blockWhileBusy}
          {...describedBy}
        >
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            {subtitle && <SheetDescription>{subtitle}</SheetDescription>}
          </SheetHeader>
          <SheetBody>{children}</SheetBody>
          <SheetFooter>
            {cancel}
            {confirm}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        ref={ref}
        className={cn("max-h-[calc(100dvh-32px)] overflow-y-auto", width)}
        closeDisabled={busy}
        onOpenAutoFocus={focusFirstField}
        onEscapeKeyDown={blockWhileBusy}
        onPointerDownOutside={blockWhileBusy}
        {...describedBy}
      >
        <DialogHeader className="gap-0.5 pr-8">
          <DialogTitle>{title}</DialogTitle>
          {subtitle && <DialogDescription className="text-[12.5px]">{subtitle}</DialogDescription>}
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3">{children}</div>
        <DialogFooter>
          {cancel}
          {confirm}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
