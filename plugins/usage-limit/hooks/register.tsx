import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Sample } from '../types'

const limits = atom({ plugin: 'usage-limit', key: 'limits' } as const, [])
const contextPercent = atom({ plugin: 'usage-limit', key: 'contextPercent' } as const, null)
// five_hour readings over the last SAMPLE_SPAN, for the burn-rate forecast
const samples = atom({ plugin: 'usage-limit', key: 'samples' } as const, [])

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const WARN_AT = [80, 90]
const SAMPLE_SPAN = 30 * 60000
const MIN_SPAN = 3 * 60000

function bar(percent: number) {
  const filled = Math.min(10, Math.round(percent / 10))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function color(percent: number, warn = 70, danger = 90) {
  return percent >= danger ? 'red' : percent >= warn ? 'yellow' : 'green'
}

function duration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits)
    await update($, contextPercent, () => usage.context.percent ?? null)
    await recordSample($, usage.rateLimits)
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
          $.ui.toast(`${LABELS[limit.kind] ?? limit.kind} usage limit passed ${crossed}%`)
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
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        {ctx !== null ? (
          <Text key="ctx">
            <Text dimColor>ctx </Text>
            <Text color={color(ctx, 60, 80)}>
              {bar(ctx)} {ctx}%
            </Text>
          </Text>
        ) : null}
        {current.map((limit, i) => {
          const resetIn = limit.resetsAt ? Date.parse(limit.resetsAt) - now : null
          const eta = limit.kind === 'five_hour' ? timeToLimit(history, limit.percentUsed) : null
          // only worth showing when the limit would arrive before the reset
          const willHit = eta !== null && (resetIn === null || eta < resetIn)
          return (
            <Text key={limit.kind}>
              {i > 0 || ctx !== null ? <Text dimColor>{'  ·  '}</Text> : null}
              <Text dimColor>{LABELS[limit.kind] ?? limit.kind} </Text>
              <Text color={color(limit.percentUsed)}>
                {bar(limit.percentUsed)} {limit.percentUsed}%
              </Text>
              {resetIn !== null ? <Text dimColor> ↻ {duration(resetIn)}</Text> : null}
              {willHit ? <Text color="red" bold> ⚠ ≈{duration(eta)} 撞线</Text> : null}
            </Text>
          )
        })}
      </Box>
    )
  })
}
