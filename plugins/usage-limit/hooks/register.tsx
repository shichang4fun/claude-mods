import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit } from '../types'

const limits = atom({ plugin: 'usage-limit', key: 'limits' } as const, [])
const contextPercent = atom({ plugin: 'usage-limit', key: 'contextPercent' } as const, null)
// output tokens per second of the main conversation's last finished response
const speed = atom({ plugin: 'usage-limit', key: 'speed' } as const, null)

const HOUR = 3_600_000
const WINDOWS: Record<string, { label: string; ms?: number; showsClock?: boolean }> = {
  five_hour: { label: '5h', ms: 5 * HOUR, showsClock: true },
  seven_day: { label: '7d', ms: 7 * 24 * HOUR },
  spend_limit: { label: '$' },
}
const WARN_AT = [80, 90]
// refreshes countdowns and the elapsed marker between measurements
const TICK_MS = 60_000
// reset clock times are shown in UTC+8
const CLOCK_OFFSET = 8 * HOUR
// responses shorter than this are too brief to time cleanly
const MIN_SPEED_MS = 1000
const MIN_SPEED_TOKENS = 20

// Layout
const BAR_CELLS = 10
const METER_GAP = 3
const SVG_COLORS: Record<string, string> = {
  green: '#4caf50',
  yellow: '#e0a526',
  red: '#e5534b',
  track: 'rgba(128,128,128,0.3)',
}

// value is the percentage; reset (countdown) and clock (reset time of day) are drawn in their own colors
type Meter = {
  key: string
  label: string
  used: number
  elapsed: number | null
  tone: string
  value: string
  reset: string | null
  clock: string | null
  // a plain figure (tok/s) draws no bar
  noBar?: boolean
}

let ticker: { cancel: () => void } | null = null

function clamp(p: number) {
  return Math.min(100, Math.max(0, p))
}

// Pace: how far usage runs ahead of the share of the window already gone
function toneOf(used: number, elapsed: number | null) {
  if (used >= 90) return 'red'
  if (elapsed === null) return used >= 80 ? 'red' : used >= 50 ? 'yellow' : 'green'
  const margin = elapsed - used
  if (margin < -15) return 'red'
  if (margin < 10 && used >= 10) return 'yellow'
  return 'green'
}

function duration(ms: number) {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

function clock(ms: number) {
  const t = new Date(ms + CLOCK_OFFSET)
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`
}

function limitMeter(limit: Limit, now: number): Meter {
  const win = WINDOWS[limit.kind]
  const label = win?.label ?? limit.kind
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : null
  // the window has reset since the last reading: it starts again from zero
  if (resetsAt !== null && resetsAt <= now) {
    return { key: limit.kind, label, used: 0, elapsed: win?.ms ? 0 : null, tone: 'green', value: '0%', reset: null, clock: null }
  }
  const resetIn = resetsAt === null ? null : resetsAt - now
  const elapsed = win?.ms && resetIn !== null ? clamp(100 - (resetIn / win.ms) * 100) : null
  const value = `${Math.round(limit.percentUsed)}%`
  const reset = resetIn === null ? null : duration(resetIn)
  const at = resetsAt !== null && win?.showsClock ? `(${clock(resetsAt)})` : null
  return { key: limit.kind, label, used: limit.percentUsed, elapsed, tone: toneOf(limit.percentUsed, elapsed), value, reset, clock: at }
}

// Desktop chips: one SVG per meter (the band's Box has no rounded backgrounds), each a tinted
// pill with an icon, label, thin bar, bold percentage and, after a divider, the reset countdown.
// Light and dark come from prefers-color-scheme inside the SVG. Icons are Lucide paths (ISC).
const CHIP_H = 20
const CHIP_PAD = 9
const ICON = 11
const GAP = 7
const LETTER = 0.6
const BAR_H = 3
const FONT = 11
const BAR_W = 36
const CHIP_THEMES: Record<string, { tint: string; accent: string; accentDark: string; icon: string }> = {
  ctx: { tint: 'rgba(70,130,240,0.16)', accent: '#3d72d6', accentDark: '#7aa5f5', icon: 'layers' },
  five_hour: { tint: 'rgba(76,175,80,0.16)', accent: '#3f8f43', accentDark: '#6cc070', icon: 'gauge' },
  seven_day: { tint: 'rgba(124,92,230,0.16)', accent: '#6d4fd6', accentDark: '#a48cf5', icon: 'calendar' },
  speed: { tint: 'rgba(224,165,38,0.18)', accent: '#b07d10', accentDark: '#f0c050', icon: 'zap' },
}
const ICONS: Record<string, string> = {
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  layers:
    '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
}

// Monospace advance: ASCII is 0.6em, anything wider (⚠, CJK) taken as a full em, plus letter-spacing
function textWidth(text: string, size = FONT) {
  return [...text].reduce((w, ch) => w + (ch.charCodeAt(0) < 128 ? 0.6 : 1) * size + LETTER, 0)
}

function esc(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function icon(name: string, x: number, cls: string) {
  const y = (CHIP_H - ICON) / 2
  return `<g class="${cls}" transform="translate(${x} ${y}) scale(${ICON / 24})" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`
}

function chipSvg(m: Meter) {
  const theme = CHIP_THEMES[m.key] ?? CHIP_THEMES.ctx
  const mid = CHIP_H / 2
  const base = mid + FONT * 0.35
  const parts: string[] = []
  let x = CHIP_PAD

  parts.push(icon(theme.icon, x, 'accent'))
  x += ICON + 5
  parts.push(`<text x="${x}" y="${base}" class="muted">${esc(m.label)}</text>`)
  x += textWidth(m.label) + GAP

  if (!m.noBar) {
    const barY = mid - BAR_H / 2
    const fill = Math.round((clamp(m.used) / 100) * BAR_W)
    parts.push(`<clipPath id="b"><rect x="${x}" y="${barY}" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>`)
    parts.push(`<g clip-path="url(#b)"><rect x="${x}" y="${barY}" width="${BAR_W}" height="${BAR_H}" fill="${SVG_COLORS.track}"/>`)
    if (fill > 0) parts.push(`<rect x="${x}" y="${barY}" width="${fill}" height="${BAR_H}" fill="${SVG_COLORS[m.tone]}"/>`)
    parts.push('</g>')
    if (m.elapsed !== null) {
      const mx = x + Math.min(BAR_W - 2, Math.max(0, Math.round((m.elapsed / 100) * BAR_W) - 1))
      parts.push(`<rect x="${mx}" y="${mid - 4}" width="1.5" height="8" rx="1" class="ink-fill"/>`)
    }
    x += BAR_W + GAP
  }

  // the percentage stays in ink while on pace, and takes the warning color once it isn't
  const pctClass = m.tone === 'green' ? 'ink' : ''
  const pctFill = m.tone === 'green' ? '' : ` fill="${SVG_COLORS[m.tone]}"`
  parts.push(`<text x="${x}" y="${base}" font-weight="700" class="${pctClass}"${pctFill}>${esc(m.value)}</text>`)
  x += textWidth(m.value)

  if (m.reset) {
    x += GAP
    parts.push(`<rect x="${x}" y="${mid - 5}" width="1" height="10" class="divider"/>`)
    x += 1 + GAP
    parts.push(icon('history', x, 'accent'))
    x += ICON + 5
    parts.push(`<text x="${x}" y="${base}" class="accent-fill">${esc(m.reset)}</text>`)
    x += textWidth(m.reset)
  }
  if (m.clock) {
    x += 5
    parts.push(`<text x="${x}" y="${base}" class="muted">${esc(m.clock)}</text>`)
    x += textWidth(m.clock)
  }
  const width = Math.ceil(x + CHIP_PAD)

  const style =
    `text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:${FONT}px;letter-spacing:${LETTER}px}` +
    `.ink{fill:#2b2b2b}.ink-fill{fill:#2b2b2b}.muted{fill:#6b6b6b}.divider{fill:rgba(0,0,0,0.15)}` +
    `.accent{stroke:${theme.accent}}.accent-fill{fill:${theme.accent}}` +
    `@media (prefers-color-scheme: dark){.ink,.ink-fill{fill:#ececec}.muted{fill:#a3a3a3}` +
    `.divider{fill:rgba(255,255,255,0.18)}.accent{stroke:${theme.accentDark}}.accent-fill{fill:${theme.accentDark}}}`
  return {
    width,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CHIP_H}" viewBox="0 0 ${width} ${CHIP_H}">` +
      `<style>${style}</style><rect width="${width}" height="${CHIP_H}" rx="${CHIP_H / 2}" fill="${theme.tint}"/>` +
      parts.join('') +
      '</svg>',
  }
}

// The terminal's bar as runs of cells: used in the tone color, the rest dim, the elapsed marker cyan
function textBarRuns(used: number, elapsed: number | null) {
  const filled = Math.round((clamp(used) / 100) * BAR_CELLS)
  const marker = elapsed === null ? -1 : Math.min(BAR_CELLS - 1, Math.floor((elapsed / 100) * BAR_CELLS))
  const runs: { kind: 'used' | 'rest' | 'marker'; text: string }[] = []
  for (let i = 0; i < BAR_CELLS; i++) {
    const kind = i === marker ? 'marker' : i < filled ? 'used' : 'rest'
    const char = kind === 'marker' ? '┃' : kind === 'used' ? '█' : '░'
    const last = runs[runs.length - 1]
    if (last && last.kind === kind) last.text += char
    else runs.push({ kind, text: char })
  }
  return runs
}

// Whether every meter fits on one line with its text bar
function barsFit(meters: Meter[], columns: number) {
  const width = meters.reduce(
    (sum, m) => sum + m.label.length + 1 + (m.noBar ? 0 : BAR_CELLS + 1) + m.value.length + (m.reset ? m.reset.length + 3 : 0) + (m.clock ? m.clock.length + 1 : 0),
    0,
  )
  return width + METER_GAP * (meters.length - 1) <= columns - 2
}

// Whether a render tree draws anything: text, or an element other than a bare Box or Text
function hasContent(node: unknown): boolean {
  if (node == null || node === false) return false
  if (typeof node === 'string') return node.trim() !== ''
  if (typeof node === 'number') return true
  if (Array.isArray(node)) return node.some(hasContent)
  const el = node as { type?: string; children?: unknown }
  if (el.type !== 'Box' && el.type !== 'Text') return true
  return hasContent(el.children)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits)
    await update($, contextPercent, () => usage.context.percent ?? null)
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await update($, contextPercent, () => e.context.percent ?? null)
    }
    if (e.changed.includes('rateLimits')) {
      const before = await read($, limits)
      for (const limit of e.rateLimits) {
        const old = before.find(l => l.kind === limit.kind)?.percentUsed ?? 0
        const crossed = WARN_AT.filter(t => old < t && limit.percentUsed >= t).pop()
        if (crossed) {
          $.ui.toast(`${WINDOWS[limit.kind]?.label ?? limit.kind} usage limit passed ${crossed}%`)
        }
      }
      await update($, limits, () => e.rateLimits)
    }
    return next(e)
  })

  // Times the main conversation's responses: output_tokens over the time from the first piece to the stop.
  // Subagents run in parallel on their own models, so they are left out.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const stream = next(e)
    let first: number | null = null
    for await (const c of stream) {
      const t = performance.now()
      if (first === null) first = t
      if (c.kind === 'stop' && c.usage) {
        const ms = t - first
        const tokens = c.usage.output_tokens
        if (ms >= MIN_SPEED_MS && tokens >= MIN_SPEED_TOKENS) {
          await update($, speed, () => tokens / (ms / 1000))
        }
      }
      yield c
    }
    return await stream.result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current: Limit[] = await read($, limits)
    const ctx = await read($, contextPercent)
    const rate = await read($, speed)
    if (e.props.hasSurvey || (current.length === 0 && ctx === null && rate === null)) {
      return next(e)
    }

    const now = await $.clock.now()
    const meters: Meter[] = []
    if (ctx !== null) {
      meters.push({ key: 'ctx', label: 'ctx', used: ctx, elapsed: null, tone: toneOf(ctx, null), value: `${ctx}%`, reset: null, clock: null })
    }
    for (const limit of current) meters.push(limitMeter(limit, now))
    if (rate !== null) {
      const value = rate < 10 ? rate.toFixed(1) : String(Math.round(rate))
      meters.push({ key: 'speed', label: 'tok/s', used: 0, elapsed: null, tone: 'green', value, reset: null, clock: null, noBar: true })
    }

    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const Svg = 'Svg' in elements ? elements.Svg : null
    const gauge = barsFit(meters, e.props.bodyColumns) ? 'text' : 'none'

    const line = Svg ? (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
        {meters.map(m => {
          const chip = chipSvg(m)
          return (
            <Svg
              key={`chip-${m.key}`}
              source={chip.source}
              alt={`${m.label} ${m.value}${m.reset ? `, resets in ${m.reset}` : ''}${m.elapsed === null ? '' : `, ${Math.round(m.elapsed)}% of the window gone`}`}
              width={chip.width}
              height={CHIP_H}
            />
          )
        })}
      </Box>
    ) : (
      <Box flexDirection="row" columnGap={METER_GAP}>
        {meters.map(m => (
          <Box key={`meter-${m.key}`} flexDirection="row" columnGap={1} alignItems="center">
            <Text>{m.label}</Text>
            {gauge === 'text' && !m.noBar ? (
              <Text>
                {textBarRuns(m.used, m.elapsed).map((run, i) =>
                  run.kind === 'marker' ? (
                    <Text key={i} color="cyan" bold>{run.text}</Text>
                  ) : run.kind === 'used' ? (
                    <Text key={i} color={m.tone}>{run.text}</Text>
                  ) : (
                    <Text key={i} dimColor>{run.text}</Text>
                  ),
                )}
              </Text>
            ) : null}
            <Text color={m.tone}>{m.value}</Text>
            {m.reset ? <Text color="cyan">↻ {m.reset}</Text> : null}
            {m.clock ? <Text dimColor>{m.clock}</Text> : null}
          </Box>
        ))}
      </Box>
    )

    // keep what later mods draw in the band
    const rest = await next(e)
    // an empty tree from below would still take the row gap, leaving a blank row under the meters
    if (!hasContent(rest)) return line
    return (
      <Box flexDirection="column" rowGap={e.surface === 'desktop' ? 1 : 0}>
        {line}
        {rest}
      </Box>
    )
  })
}
