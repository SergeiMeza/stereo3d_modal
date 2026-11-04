import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/** Status chips. Tones map to the status tokens in index.css. */
const badgeVariants = cva(
  "inline-flex h-5.5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 text-xs font-medium whitespace-nowrap tabular-nums focus-visible:ring-2 focus-visible:ring-ring [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-border bg-secondary text-foreground",
        blue: "border-info/35 bg-info/10 text-info-foreground",
        green: "border-success/30 bg-success/10 text-success-foreground",
        amber: "border-warning/30 bg-warning/10 text-warning-foreground",
        red: "border-destructive/30 bg-destructive/10 text-destructive-foreground",
        violet: "border-violet/35 bg-violet/10 text-violet-foreground",
        muted: "border-border text-muted-foreground",
        outline: "border-border text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants, type BadgeVariant };
