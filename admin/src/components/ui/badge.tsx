import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/** Status chips. Tones map to the status tokens in index.css. */
const badgeVariants = cva(
  "inline-flex h-5.5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-1.75 text-xs font-medium whitespace-nowrap tabular-nums focus-visible:ring-2 focus-visible:ring-ring [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-neutral-bg text-neutral-foreground",
        plain: "bg-neutral-bg text-neutral-foreground",
        blue: "bg-info-bg text-info-foreground",
        green: "bg-success-bg text-success-foreground",
        amber: "bg-warning-bg text-warning-foreground",
        red: "bg-destructive-bg text-destructive-foreground",
        violet: "bg-violet-bg text-violet-foreground",
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
