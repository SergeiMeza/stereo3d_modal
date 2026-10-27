import { useEffect, useState } from 'react'
import { useAtom } from 'jotai'
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Clock,
  Coins,
  Gauge,
  LayoutGrid,
  ListTree,
  Menu,
  MousePointerClick,
  Percent,
  Users,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { href, type Page, type Route } from '@/lib/router'
import { cn } from '@/lib/utils'
import { sidebarCollapsedAtom } from '@/state'

export interface SectionLink {
  id: string
  label: string
  icon: LucideIcon
}

/** Sections per page, in the order the page renders them; the sidebar links jump to their anchors. */
export const PAGE_SECTIONS: Partial<Record<Page, SectionLink[]>> = {
  overview: [
    { id: 'overview', label: 'This period', icon: Gauge },
    { id: 'cash', label: 'Cash and customers', icon: Coins },
    { id: 'runs', label: 'Runs by step', icon: ListTree },
    { id: 'payers', label: 'Payers', icon: Users },
  ],
  errors: [
    { id: 'failure', label: 'Failure rates', icon: AlertTriangle },
    { id: 'failed', label: 'Failed runs', icon: ListTree },
    { id: 'overdue', label: 'Overdue and reports', icon: Clock },
    { id: 'canceled', label: 'Canceled runs', icon: X },
    { id: 'billing', label: 'Billing problems', icon: Coins },
  ],
  margin: [
    { id: 'margin', label: 'Totals', icon: Percent },
    { id: 'margin-steps', label: 'By step and preset', icon: ListTree },
    { id: 'margin-days', label: 'Over time', icon: BarChart3 },
    { id: 'margin-runs', label: 'Waived and costliest', icon: Coins },
  ],
}

interface PageLink {
  route: Route
  label: string
  icon: LucideIcon
}

const GROUPS: { label: string; pages: PageLink[] }[] = [
  {
    label: 'Business',
    pages: [
      { route: { name: 'overview' }, label: 'Overview', icon: LayoutGrid },
      { route: { name: 'margin' }, label: 'Margin', icon: Percent },
    ],
  },
  {
    label: 'Product',
    pages: [{ route: { name: 'errors' }, label: 'Errors', icon: AlertTriangle }],
  },
  {
    label: 'Growth',
    pages: [{ route: { name: 'website' }, label: 'Website', icon: MousePointerClick }],
  },
]

function useActiveAnchor(sections: SectionLink[] | undefined): string | null {
  const [active, setActive] = useState<string | null>(null)
  const ids = sections?.map((s) => s.id).join(',') ?? ''
  useEffect(() => {
    if (!ids) {
      setActive(null)
      return
    }
    const list = ids.split(',')
    const onScroll = () => {
      let best: string | null = null
      for (const id of list) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= 120) best = id
      }
      setActive(best ?? list[0])
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [ids])
  return active
}

export function Sidebar({ route }: { route: Route }) {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const [open, setOpen] = useState(false)
  const page = route.name
  const sections = PAGE_SECTIONS[page]
  const anchor = useActiveAnchor(sections)

  useEffect(() => setOpen(false), [route])

  const pageLink = (p: PageLink) => {
    const Icon = p.icon
    const isActive = p.route.name === page
    const link = (
      <a
        key={p.label}
        href={href(p.route)}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
          isActive ? 'bg-accent/10 text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
          collapsed && 'justify-center px-0',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        {collapsed ? <span className="sr-only">{p.label}</span> : p.label}
      </a>
    )
    return collapsed ? (
      <Tooltip key={p.label}>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{p.label}</TooltipContent>
      </Tooltip>
    ) : (
      link
    )
  }

  const nav = (
    <nav aria-label="Pages" className="flex flex-1 flex-col gap-3 overflow-y-auto p-2">
      {GROUPS.map((g) => (
        <div key={g.label} className="flex flex-col gap-0.5">
          {collapsed ? (
            <div className="mx-2 my-1 border-t border-line" aria-hidden />
          ) : (
            <p className="px-2 pb-1 pt-1 text-[0.65rem] font-semibold uppercase tracking-wider text-ink-3">{g.label}</p>
          )}
          {g.pages.map((p) => (
            <div key={p.label}>
              {pageLink(p)}
              {p.route.name === page && sections && !collapsed ? (
                <ul className="ml-4 mt-0.5 space-y-px border-l border-line pl-3">
                  {sections.map((s) => (
                    <li key={s.id}>
                      <a
                        href={href(p.route)}
                        onClick={(e) => {
                          e.preventDefault()
                          document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }}
                        aria-current={anchor === s.id ? 'true' : undefined}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors',
                          anchor === s.id ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
                        )}
                      >
                        <s.icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        {s.label}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </nav>
  )

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        className="fixed bottom-4 left-4 z-50 shadow-pop lg:hidden"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Menu className="h-4 w-4" aria-hidden />
      </Button>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ground/70 backdrop-blur-sm" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 flex w-60 flex-col border-r border-line bg-surface shadow-pop animate-fade-in">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="text-sm font-semibold text-ink">Navigate</span>
              <Button variant="ghost" size="icon" aria-label="Close navigation" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            {nav}
          </div>
        </div>
      ) : null}
      <aside
        className={cn(
          'sticky top-[3.25rem] hidden h-[calc(100vh-3.25rem)] shrink-0 flex-col border-r border-line bg-surface/40 lg:flex',
          collapsed ? 'w-14' : 'w-52',
        )}
      >
        {nav}
        <div className="border-t border-line p-2">
          <Button variant="ghost" size="icon" className="w-full" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronRight className="h-4 w-4" aria-hidden /> : <ChevronLeft className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
      </aside>
    </>
  )
}
