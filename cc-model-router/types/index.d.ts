export type Tier = 'simple' | 'medium' | 'hard'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type DecisionSource = 'prefix' | 'rule' | 'classifier' | 'sticky' | 'escalated' | 'step'

export type Decision = { tier: Tier; model: string; effort?: Effort; source: DecisionSource; reason: string; at: number }

export type RouterState = { isOn: boolean; stickyTier: Tier | null; decision: Decision | null }

declare module 'claude-code' {
  interface PluginState {
    'cc-model-router': { router: RouterState }
  }
}
