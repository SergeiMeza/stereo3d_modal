import * as React from "react";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/**
 * Form fields (shadcn Field): a label tied to its control, an optional
 * description and an error. `Field` wires the ids, so every control is
 * labelled and described without passing ids by hand.
 */

const FieldContext = React.createContext<{ id: string; descId: string; errId: string } | null>(null);

function useFieldIds() {
  return React.useContext(FieldContext);
}

function Field({ className, children, ...props }: React.ComponentProps<"div">) {
  const id = React.useId();
  const value = React.useMemo(() => ({ id: `${id}-control`, descId: `${id}-desc`, errId: `${id}-err` }), [id]);
  return (
    <FieldContext.Provider value={value}>
      <div data-slot="field" className={cn("flex w-full min-w-0 flex-1 flex-col gap-1.5", className)} {...props}>
        {children}
      </div>
    </FieldContext.Provider>
  );
}

function FieldLabel({ className, htmlFor, ...props }: React.ComponentProps<typeof Label>) {
  const ids = useFieldIds();
  return <Label data-slot="field-label" htmlFor={htmlFor ?? ids?.id} className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

/** Passes the field's id and aria-describedby to its single child control. */
function FieldControl({ children, describedBy = true }: { children: React.ReactElement<Record<string, unknown>>; describedBy?: boolean }) {
  const ids = useFieldIds();
  if (!ids) return children;
  return React.cloneElement(children, {
    id: (children.props.id as string | undefined) ?? ids.id,
    "aria-describedby": describedBy ? `${ids.descId} ${ids.errId}` : undefined,
  });
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  const ids = useFieldIds();
  return <p data-slot="field-description" id={ids?.descId} className={cn("text-2xs text-muted-foreground", className)} {...props} />;
}

function FieldError({ className, children, ...props }: React.ComponentProps<"p">) {
  const ids = useFieldIds();
  if (!children) return null;
  return (
    <p data-slot="field-error" id={ids?.errId} role="alert" className={cn("text-xs text-destructive-foreground", className)} {...props}>
      {children}
    </p>
  );
}

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return <fieldset data-slot="field-set" className={cn("m-0 flex flex-col gap-2 border-0 p-0", className)} {...props} />;
}

function FieldLegend({ className, ...props }: React.ComponentProps<"legend">) {
  return <legend data-slot="field-legend" className={cn("mb-1 text-xs text-muted-foreground", className)} {...props} />;
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("flex w-full flex-col gap-3", className)} {...props} />;
}

export { Field, FieldLabel, FieldControl, FieldDescription, FieldError, FieldSet, FieldLegend, FieldGroup };
