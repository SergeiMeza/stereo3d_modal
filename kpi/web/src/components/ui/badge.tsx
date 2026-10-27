import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4', {
  variants: {
    variant: {
      neutral: 'bg-surface-2 text-ink-2',
      good: 'bg-good/10 text-good',
      warn: 'bg-warn/15 text-warn',
      crit: 'bg-crit/10 text-crit',
      accent: 'bg-accent/10 text-accent',
    },
  },
  defaultVariants: { variant: 'neutral' },
})

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
