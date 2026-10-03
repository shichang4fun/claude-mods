import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Sample } from '../types'

const limits = atom({ plugin: 'usage-limit', key: 'limits' } as const, [])
const contextPercent = atom({ plugin: 'usage-limit', key: 'contextPercent' } as const, null)
// five_hour readings over the last SAMPLE_SPAN, for the time-to-limit forecast
const samples = atom({ plugin: 'usage-limit', key: 'samples' } as const, [])

const HOUR = 3_600_000
const WINDOWS: Record<string, { label: string; ms?: number; showsClock?: boolean }> = {
  five_hour: { label: '5h', ms: 5 * HOUR, showsClock: true },
  seven_day: { label: '7d', ms: 7 * 24 * HOUR },
  spend_limit: { label: '$' },
}
const WARN_AT = [80, 90]
const SAMPLE_SPAN = 30 * 60_000
const MIN_SPAN = 3 * 60_000
// refreshes countdowns and the elapsed marker between measurements
const TICK_MS = 60_000
// reset clock times are shown in UTC+8
const CLOCK_OFFSET = 8 * HOUR

// Layout
const BAR_CELLS = 10
const METER_GAP = 3
const SVG_W = 96
const SVG_H = 10
const SVG_COLORS: Record<string, string> = {
  green: '#4caf50',
  yellow: '#e0a526',
  red: '#e5534b',
  track: 'rgba(128,128,128,0.3)',
  marker: '#5b9bff',
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
  warning: string | null
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
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`
}

function clock(ms: number) {
  const t = new Date(ms + CLOCK_OFFSET)
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`
}

// ms until five_hour reaches 100% at the recent rate; null when flat or too few readings
function timeToLimit(history: Sample[], percent: number) {
  if (history.length < 2) return null
  const first = history[0]
  const last = history[history.length - 1]
  const span = last.t - first.t
  const rise = last.p - first.p
  if (span < MIN_SPAN || rise <= 0) return null
  return ((100 - percent) / rise) * span
}

async function recordSample($: EngineInterface, rateLimits: Limit[]) {
  const five = rateLimits.find(l => l.kind === 'five_hour')
  if (!five) return
  const t = await $.clock.now()
  await update($, samples, (prev: Sample[]) => {
    const last = prev[prev.length - 1]
    // a drop means the window reset: start over
    const kept = last && five.percentUsed < last.p ? [] : prev.filter(s => t - s.t <= SAMPLE_SPAN)
    return [...kept, { t, p: five.percentUsed }]
  })
}

function limitMeter(limit: Limit, now: number, history: Sample[]): Meter {
  const win = WINDOWS[limit.kind]
  const label = win?.label ?? limit.kind
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : null
  // the window has reset since the last reading: it starts again from zero
  if (resetsAt !== null && resetsAt <= now) {
    return { key: limit.kind, label, used: 0, elapsed: win?.ms ? 0 : null, tone: 'green', value: '0%', reset: null, clock: null, warning: null }
  }
  const resetIn = resetsAt === null ? null : resetsAt - now
  const elapsed = win?.ms && resetIn !== null ? clamp(100 - (resetIn / win.ms) * 100) : null
  const value = `${Math.round(limit.percentUsed)}%`
  const reset = resetIn === null ? null : duration(resetIn)
  const at = resetsAt !== null && win?.showsClock ? `(${clock(resetsAt)})` : null
  const eta = limit.kind === 'five_hour' ? timeToLimit(history, limit.percentUsed) : null
  // only worth showing when the limit would arrive before the reset
  const warning = eta !== null && (resetIn === null || eta < resetIn) ? `⚠ ≈${duration(eta)} 撞线` : null
  return { key: limit.kind, label, used: limit.percentUsed, elapsed, tone: toneOf(limit.percentUsed, elapsed), value, reset, clock: at, warning }
}

function svgBar(used: number, elapsed: number | null, tone: string) {
  const fill = Math.round((clamp(used) / 100) * SVG_W)
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}">`,
    `<clipPath id="c"><rect width="${SVG_W}" height="${SVG_H}" rx="${SVG_H / 2}"/></clipPath>`,
    `<g clip-path="url(#c)"><rect width="${SVG_W}" height="${SVG_H}" fill="${SVG_COLORS.track}"/>`,
    fill > 0 ? `<rect width="${fill}" height="${SVG_H}" fill="${SVG_COLORS[tone]}"/>` : '',
    '</g>',
  ]
  if (elapsed !== null) {
    const x = Math.min(SVG_W - 2, Math.max(0, Math.round((elapsed / 100) * SVG_W) - 1))
    parts.push(`<rect x="${x}" width="2" height="${SVG_H}" fill="${SVG_COLORS.marker}"/>`)
  }
  parts.push('</svg>')
  return parts.join('')
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
    (sum, m) => sum + m.label.length + 1 + BAR_CELLS + 1 + m.value.length + (m.reset ? m.reset.length + 3 : 0) + (m.clock ? m.clock.length + 1 : 0) + (m.warning ? m.warning.length + 2 : 0),
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
    await recordSample($, usage.rateLimits)
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
      await recordSample($, e.rateLimits)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current: Limit[] = await read($, limits)
    const ctx = await read($, contextPercent)
    if (e.props.hasSurvey || (current.length === 0 && ctx === null)) {
      return next(e)
    }

    const now = await $.clock.now()
    const history: Sample[] = await read($, samples)
    const meters: Meter[] = []
    if (ctx !== null) {
      meters.push({ key: 'ctx', label: 'ctx', used: ctx, elapsed: null, tone: toneOf(ctx, null), value: `${ctx}%`, reset: null, clock: null, warning: null })
    }
    for (const limit of current) meters.push(limitMeter(limit, now, history))

    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const Svg = 'Svg' in elements ? elements.Svg : null
    const gauge = Svg ? 'svg' : barsFit(meters, e.props.bodyColumns) ? 'text' : 'none'

    const line = (
      <Box flexDirection="row" columnGap={METER_GAP}>
        {meters.map(m => (
          <Box key={`meter-${m.key}`} flexDirection="row" columnGap={1} alignItems="center">
            <Text>{m.label}</Text>
            {gauge === 'svg' && Svg ? (
              <Svg
                source={svgBar(m.used, m.elapsed, m.tone)}
                alt={`${m.label} ${m.value}${m.reset ? `, resets in ${m.reset}` : ''}${m.elapsed === null ? '' : `, ${Math.round(m.elapsed)}% of the window gone`}`}
                width={SVG_W}
                height={SVG_H}
              />
            ) : gauge === 'text' ? (
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
            {m.reset ? <Text color={Svg ? SVG_COLORS.marker : 'cyan'}>↻ {m.reset}</Text> : null}
            {m.clock ? <Text dimColor>{m.clock}</Text> : null}
            {m.warning ? <Text color="red" bold>{m.warning}</Text> : null}
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
