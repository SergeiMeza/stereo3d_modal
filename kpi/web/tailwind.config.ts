import type { Config } from 'tailwindcss'

// Colours are CSS custom properties holding "r g b" triplets so Tailwind's
// opacity modifiers keep working (see src/index.css for the values).
const v = (name: string) => `rgb(var(${name}) / <alpha-value>)`

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: v('--ground'),
        surface: v('--surface'),
        'surface-2': v('--surface-2'),
        line: v('--line'),
        'line-strong': v('--line-strong'),
        ink: v('--ink'),
        'ink-2': v('--ink-2'),
        'ink-3': v('--ink-3'),
        accent: v('--accent'),
        'accent-ink': v('--accent-ink'),
        good: v('--good'),
        warn: v('--warn'),
        crit: v('--crit'),
        s1: v('--s1'),
        s2: v('--s2'),
        s3: v('--s3'),
        s4: v('--s4'),
        s5: v('--s5'),
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        display: [
          '"SF Pro Display"',
          '-apple-system',
          'system-ui',
          '"Segoe UI Variable Display"',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        lg: '12px',
        md: '8px',
        sm: '6px',
      },
      boxShadow: {
        card: '0 1px 0 rgb(var(--shadow) / 0.06), 0 1px 2px rgb(var(--shadow) / 0.04)',
        pop: '0 8px 24px rgb(var(--shadow) / 0.18), 0 1px 0 rgb(var(--shadow) / 0.08)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(2px)' }, to: { opacity: '1', transform: 'none' } },
        shimmer: { '0%': { opacity: '0.55' }, '50%': { opacity: '1' }, '100%': { opacity: '0.55' } },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
