import { useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Header } from '@/components/Header'
import { Sidebar } from '@/components/Sidebar'
import { PageFilters, type FilterKey } from '@/components/PageFilters'
import { OverviewPage } from '@/components/pages/OverviewPage'
import { ErrorsPage } from '@/components/pages/ErrorsPage'
import { MarginPage } from '@/components/pages/MarginPage'
import { WebsitePage } from '@/components/pages/WebsitePage'
import { useRoute, type Page } from '@/lib/router'
import { resolveTheme, themeAtom } from '@/state'

function useApplyTheme() {
  const setting = useAtomValue(themeAtom)
  useEffect(() => {
    const apply = () => document.documentElement.classList.toggle('dark', resolveTheme(setting) === 'dark')
    apply()
    if (setting !== 'system') return
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    } catch {
      return
    }
  }, [setting])
}

/** What each page's numbers respond to. */
const PAGE_FILTERS: Record<Page, { controls: FilterKey[]; note?: string }> = {
  overview: { controls: ['range', 'grain'], note: 'Cash by the day it was collected; runs by the day they were created; UTC days' },
  errors: { controls: ['range', 'grain'], note: 'Rates and lists by the day a run was created; overdue runs, reports and billing problems are all time' },
  margin: { controls: ['range', 'grain'], note: 'Revenue and GPU cost both by the day the run was created' },
  website: { controls: ['range'], note: 'Vercel reports days, not accounts: visitors are counted once per day and page' },
}

/** The question each page answers. */
const PAGE_TITLES: Record<Page, { title: string; question: string }> = {
  overview: { title: 'Overview', question: 'How much money came in, from how many people, and what are they running?' },
  errors: { title: 'Errors', question: 'Which runs fail, stall or get canceled, and what did users report?' },
  margin: { title: 'Margin', question: 'Does each step earn more than its GPUs cost?' },
  website: { title: 'Website', question: 'Who visits the site, from where, and what do they click?' },
}

export default function App() {
  useApplyTheme()
  const route = useRoute()
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [route.name])
  const t = PAGE_TITLES[route.name]
  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen">
        <Header />
        <div className="mx-auto flex w-full max-w-[1600px]">
          <Sidebar route={route} />
          <div className="min-w-0 flex-1">
            <main className="w-full space-y-6 px-4 pb-16 pt-6 sm:px-6 lg:px-8">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-ink">{t.title}</h2>
                <p className="text-sm text-ink-3">{t.question}</p>
              </div>
              <PageFilters {...PAGE_FILTERS[route.name]} />
              {route.name === 'overview' ? (
                <OverviewPage />
              ) : route.name === 'errors' ? (
                <ErrorsPage />
              ) : route.name === 'margin' ? (
                <MarginPage />
              ) : (
                <WebsitePage />
              )}
            </main>
            <footer className="px-4 pb-8 text-xs text-ink-3 sm:px-6 lg:px-8">
              Stereo3D Studio · Spatial AI Labs · all money in USD · all days UTC · prod records, read-only
            </footer>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
