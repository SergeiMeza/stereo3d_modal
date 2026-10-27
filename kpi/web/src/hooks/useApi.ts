import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import * as api from '@/api/client'
import type { Errors, Margin, Meta, Overview, Site } from '@/api/types'
import { grainAtom, rangeAtom, refreshTickAtom } from '@/state'

export interface ApiState<T> {
  data: T | null
  error: string | null
  loading: boolean
  retry: () => void
}

/** Minimal fetch hook: re-runs `fetcher` whenever `key` changes, aborts the previous request, keeps
 *  the last data visible while reloading. */
export function useApi<T>(fetcher: (signal: AbortSignal) => Promise<T>, key: string): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    const ctrl = new AbortController()
    let alive = true
    setLoading(true)
    setError(null)
    fetcherRef
      .current(ctrl.signal)
      .then((d) => {
        if (!alive) return
        setData(d)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!alive || ctrl.signal.aborted) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [key, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { data, error, loading, retry }
}

export function useMeta(): ApiState<Meta> {
  const tick = useAtomValue(refreshTickAtom)
  return useApi((s) => api.getMeta(s), `meta:${tick}`)
}

export function useOverview(): ApiState<Overview> {
  const r = useAtomValue(rangeAtom)
  const grain = useAtomValue(grainAtom)
  const tick = useAtomValue(refreshTickAtom)
  return useApi((s) => api.getOverview(r, grain, s), `overview:${r.from}:${r.to}:${grain}:${tick}`)
}

export function useErrors(): ApiState<Errors> {
  const r = useAtomValue(rangeAtom)
  const grain = useAtomValue(grainAtom)
  const tick = useAtomValue(refreshTickAtom)
  return useApi((s) => api.getErrors(r, grain, s), `errors:${r.from}:${r.to}:${grain}:${tick}`)
}

export function useMargin(): ApiState<Margin> {
  const r = useAtomValue(rangeAtom)
  const grain = useAtomValue(grainAtom)
  const tick = useAtomValue(refreshTickAtom)
  return useApi((s) => api.getMargin(r, grain, s), `margin:${r.from}:${r.to}:${grain}:${tick}`)
}

export function useSite(): ApiState<Site> {
  const r = useAtomValue(rangeAtom)
  const tick = useAtomValue(refreshTickAtom)
  return useApi((s) => api.getSite(r, s), `site:${r.from}:${r.to}:${tick}`)
}
