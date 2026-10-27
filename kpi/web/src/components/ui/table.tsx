import * as React from 'react'
import { cn } from '@/lib/utils'

/** Tables live inside an overflow-x container so the page itself never scrolls sideways. The first
 *  and last columns carry no side padding, so a table lines up with the padded card content around
 *  it; in a card without padding (`CardContent className="p-0"`, a title with its own `px-4`) pass
 *  `inset` and the table keeps the same 16 px from the card's edges. */
/** `stickyHeader` keeps the column titles in view: the table scrolls inside its own box (a sticky
 *  header cannot stick to the page from inside an overflow-x container), capped below the app header. */
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement> & { inset?: boolean; stickyHeader?: boolean }>(
  ({ className, inset, stickyHeader, ...props }, ref) => (
    <div className={cn('relative w-full overflow-x-auto', stickyHeader && 'max-h-[calc(100vh-9rem)] overflow-y-auto')}>
      <table
        ref={ref}
        className={cn(
          'w-full caption-bottom text-sm',
          // On the edge cells rather than the container, so a table wider than its card keeps the
          // inset at the end of its scroll too.
          inset && '[&_tr>*:first-child]:pl-4 [&_tr>*:last-child]:pr-4',
          stickyHeader &&
            '[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-surface [&_thead_th]:shadow-[inset_0_-1px_0_rgb(var(--line))]',
          className,
        )}
        {...props}
      />
    </div>
  ),
)
Table.displayName = 'Table'

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />,
)
TableHeader.displayName = 'TableHeader'

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />,
)
TableBody.displayName = 'TableBody'

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot ref={ref} className={cn('border-t bg-surface-2/60 font-medium [&>tr]:last:border-b-0', className)} {...props} />
  ),
)
TableFooter.displayName = 'TableFooter'

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(({ className, ...props }, ref) => (
  <tr ref={ref} className={cn('border-b border-line transition-colors hover:bg-surface-2/60', className)} {...props} />
))
TableRow.displayName = 'TableRow'

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn('h-8 px-2 text-left align-middle text-[11px] font-medium uppercase tracking-wide text-ink-3 first:pl-0 last:pr-0', className)}
    {...props}
  />
))
TableHead.displayName = 'TableHead'

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-2 py-2 align-middle first:pl-0 last:pr-0', className)} {...props} />
))
TableCell.displayName = 'TableCell'

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell }
