import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded-md border border-input bg-[var(--surface-strong)] px-3 py-1 text-base text-[var(--text)] shadow-none transition-[border-color,box-shadow] duration-[var(--dur-1)] outline-none placeholder:text-muted-foreground selection:bg-[var(--accent)] selection:text-white file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-[var(--accent)] focus-visible:ring-[4px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_16%,transparent)]",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
