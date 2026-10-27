import * as React from 'react'
import { cn } from '@/lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-8 rounded-md border border-line-strong/70 bg-surface px-2 text-sm text-ink num placeholder:text-ink-3 focus-visible:border-accent',
      className,
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export { Input }
