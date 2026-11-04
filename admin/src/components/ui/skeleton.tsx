import type * as React from "react";

import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="skeleton" className={cn("block h-2.5 animate-pulse rounded-md bg-accent motion-reduce:animate-none", className)} {...props} />;
}

export { Skeleton };
