import type { Errors, Grain, IngestRun, Margin, Meta, Overview, Site } from './types'

export interface RangeParams {
  from: string
  to: string
}

type Query = Record<string, string | number | undefined>

function url(path: string, query?: Query): string {
  const qs = new URLSearchParams()
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') qs.set(k, String(v))
    }
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

async function request<T>(path: string, init: RequestInit & { query?: Query } = {}): Promise<T> {
  const { query, ...rest } = init
  const res = await fetch(url(path, query), { ...rest, headers: { Accept: 'application/json', ...(rest.headers ?? {}) } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 400)}` : ''}`)
  }
  return (await res.json()) as T
}

export function getMeta(signal?: AbortSignal): Promise<Meta> {
  return request<Meta>('/api/meta', { signal })
}

export function getOverview(r: RangeParams, grain: Grain, signal?: AbortSignal): Promise<Overview> {
  return request<Overview>('/api/overview', { signal, query: { from: r.from, to: r.to, grain } })
}

export function getErrors(r: RangeParams, grain: Grain, signal?: AbortSignal): Promise<Errors> {
  return request<Errors>('/api/errors', { signal, query: { from: r.from, to: r.to, grain } })
}

export function getMargin(r: RangeParams, grain: Grain, signal?: AbortSignal): Promise<Margin> {
  return request<Margin>('/api/margin', { signal, query: { from: r.from, to: r.to, grain } })
}

export function getSite(r: RangeParams, signal?: AbortSignal): Promise<Site> {
  return request<Site>('/api/site', { signal, query: { from: r.from, to: r.to } })
}

export function runIngest(signal?: AbortSignal): Promise<IngestRun> {
  return request<IngestRun>('/api/ingest/run', { method: 'POST', signal })
}
