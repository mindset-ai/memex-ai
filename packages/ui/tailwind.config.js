/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* ── Surfaces ── */
        page:          'rgb(var(--color-page) / <alpha-value>)',
        surface:       'rgb(var(--color-surface) / <alpha-value>)',
        input:         'rgb(var(--color-input) / <alpha-value>)',
        'card-hover':  'rgb(var(--color-card-hover) / <alpha-value>)',
        selected:      'rgb(var(--color-selected) / <alpha-value>)',
        panel:         'var(--color-panel)',           /* baked opacity */
        overlay:       'var(--color-overlay)',          /* baked opacity */

        /* ── Text ── */
        heading:       'rgb(var(--color-text-heading) / <alpha-value>)',
        primary:       'rgb(var(--color-text-primary) / <alpha-value>)',
        secondary:     'rgb(var(--color-text-secondary) / <alpha-value>)',
        muted:         'rgb(var(--color-text-muted) / <alpha-value>)',

        /* ── Borders ── */
        edge:          'rgb(var(--color-edge) / <alpha-value>)',
        'edge-subtle': 'var(--color-edge-subtle)',     /* baked opacity */
        'edge-strong': 'rgb(var(--color-edge-strong) / <alpha-value>)',

        /* ── Interactive ── */
        'btn-primary':       'rgb(var(--color-btn-primary) / <alpha-value>)',
        'btn-primary-hover': 'rgb(var(--color-btn-primary-hover) / <alpha-value>)',
        'btn-secondary':       'rgb(var(--color-btn-secondary) / <alpha-value>)',
        'btn-secondary-hover': 'rgb(var(--color-btn-secondary-hover) / <alpha-value>)',

        /* ── Accent ── */
        accent:        'rgb(var(--color-accent) / <alpha-value>)',
        'accent-hover':'rgb(var(--color-accent-hover) / <alpha-value>)',
        'on-accent':   'rgb(var(--color-on-accent) / <alpha-value>)',

        /* ── Agent (Prompt Button) ── */
        agent:         'rgb(var(--color-agent) / <alpha-value>)',
        'agent-hover': 'rgb(var(--color-agent-hover) / <alpha-value>)',

        /* ── Chips ── */
        chip:          'var(--color-chip)',             /* baked opacity */
        'chip-text':   'rgb(var(--color-chip-text) / <alpha-value>)',
        'chip-border': 'rgb(var(--color-chip-border) / <alpha-value>)',

        /* ── Status: warning (draft, open) ── */
        'status-warning-bg':     'var(--color-status-warning-bg)',
        'status-warning-text':   'rgb(var(--color-status-warning-text) / <alpha-value>)',
        'status-warning-border': 'rgb(var(--color-status-warning-border) / <alpha-value>)',

        /* ── Status: success (active, resolved, complete) ── */
        'status-success-bg':     'var(--color-status-success-bg)',
        'status-success-text':   'rgb(var(--color-status-success-text) / <alpha-value>)',
        'status-success-border': 'rgb(var(--color-status-success-border) / <alpha-value>)',

        /* ── Status: info (in_progress) ── */
        'status-info-bg':        'var(--color-status-info-bg)',
        'status-info-text':      'rgb(var(--color-status-info-text) / <alpha-value>)',
        'status-info-border':    'rgb(var(--color-status-info-border) / <alpha-value>)',

        /* ── Status: danger (blocked, error) ── */
        'status-danger-bg':      'var(--color-status-danger-bg)',
        'status-danger-text':    'rgb(var(--color-status-danger-text) / <alpha-value>)',
        'status-danger-border':  'rgb(var(--color-status-danger-border) / <alpha-value>)',

        /* ── Status: neutral (not_started, archived, pending) ── */
        'status-neutral-bg':     'var(--color-status-neutral-bg)',
        'status-neutral-text':   'rgb(var(--color-status-neutral-text) / <alpha-value>)',
        'status-neutral-border': 'rgb(var(--color-status-neutral-border) / <alpha-value>)',
      },
    },
  },
  plugins: [],
}
