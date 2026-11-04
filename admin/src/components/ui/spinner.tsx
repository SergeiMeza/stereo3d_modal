import type * as React from "react";
import { Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";

function Spinner({ className, label = "Loading", ...props }: React.ComponentProps<"svg"> & { label?: string }) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label={label}
      className={cn("size-4.5 animate-spin text-muted-foreground motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Spinner };
