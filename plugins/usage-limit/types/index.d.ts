export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Sample = { t: number; p: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-limit': { limits: Limit[]; contextPercent: number | null; samples: Sample[] }
  }
}
