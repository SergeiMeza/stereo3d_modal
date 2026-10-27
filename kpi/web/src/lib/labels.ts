import { EM_DASH } from '@/lib/format'

/** What each run type is called on the dashboard. */
export const RUN_TYPE_LABELS: Record<string, string> = {
  depth_preview: 'Depth preview',
  stereo_preview: 'Stereo preview',
  production: 'Production',
  video: 'Video (mobile)',
  image: 'Photo',
  analyze: 'Analyze (free)',
}

export const runTypeLabel = (t: string) => RUN_TYPE_LABELS[t] ?? t

/** A uid or id shortened for a table cell; the full value goes in the title attribute. */
export function shortId(id: string | null | undefined, head = 8): string {
  if (!id) return EM_DASH
  return id.length <= head + 1 ? id : `${id.slice(0, head)}…`
}
