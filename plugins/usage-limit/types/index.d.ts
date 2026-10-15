export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-limit': { limits: Limit[]; contextPercent: number | null; speed: number | null }
  }
}
