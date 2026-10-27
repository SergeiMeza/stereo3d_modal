// A hash router small enough not to need a dependency. Routes:
//   #/          Overview: cash, customers, value per payer, runs by step and state
//   #/errors    Failure rates, failed / canceled / overdue runs, user reports, billing problems
//   #/margin    Revenue against GPU cost per step, preset and day
//   #/website   The website's Vercel Web Analytics
import { useEffect, useState } from 'react'

export type Route = { name: 'overview' } | { name: 'errors' } | { name: 'margin' } | { name: 'website' }
export type Page = Route['name']

export function parseHash(hash: string): Route {
  const first = hash.replace(/^#/, '').replace(/^\/+/, '').split('?')[0].split('/')[0]
  if (first === 'errors' || first === 'margin' || first === 'website') return { name: first }
  return { name: 'overview' }
}

export function href(route: Route): string {
  return route.name === 'overview' ? '#/' : `#/${route.name}`
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}
