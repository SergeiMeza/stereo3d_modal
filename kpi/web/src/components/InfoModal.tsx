// A round "i" beside a chart or table title; it opens a small modal that says what the
// thing is and how to read it. No dialog primitive is installed (only popover, select,
// tabs, tooltip), so this is a portal with role="dialog", Escape and click-outside.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export function InfoButton({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const close = useCallback(() => {
    setOpen(false)
    openerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('keydown', onKey)
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [open, close])

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        aria-label="What is this?"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="What is this?"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink',
          className,
        )}
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open
        ? createPortal(
            <div
              className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-ground/70 p-4 backdrop-blur-sm sm:items-center"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) close()
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="my-auto w-full max-w-lg rounded-lg border border-line bg-surface p-5 text-ink shadow-pop animate-fade-in"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <h2 id={titleId} className="text-sm font-semibold tracking-tight text-ink">
                    {title}
                  </h2>
                  <button
                    ref={closeRef}
                    type="button"
                    aria-label="Close"
                    onClick={close}
                    className="-m-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                <div className="space-y-2 text-xs leading-relaxed text-ink-2 [&_b]:font-semibold [&_b]:text-ink [&_li]:ml-4 [&_li]:list-disc [&_ul]:space-y-1">
                  {children}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

/** The closing line of every modal: what to do with the thing you are looking at. */
export function HowToRead({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 border-t border-line pt-2 text-xs text-ink-2">
      <b className="font-semibold text-ink">How to read it: </b>
      {children}
    </p>
  )
}
