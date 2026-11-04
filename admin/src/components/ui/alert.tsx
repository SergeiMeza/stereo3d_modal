import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/** Banners: a tinted row with text and an optional action on the right. */
const alertVariants = cva("flex w-full items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm", {
  variants: {
    variant: {
      blue: "border-info/30 bg-info/8 text-info-foreground",
      amber: "border-warning/30 bg-warning/8 text-warning-foreground",
      red: "border-destructive/35 bg-destructive/8 text-destructive-foreground",
    },
  },
  defaultVariants: { variant: "blue" },
});

function Alert({
  className,
  variant,
  role = "status",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role={role} className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("min-w-0 flex-1", className)} {...props} />;
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-action" className={cn("shrink-0", className)} {...props} />;
}

export { Alert, AlertDescription, AlertAction };
