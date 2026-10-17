import type { Context, PromptFreezeConfig } from './backend/types.js'
import z from '@deepseek-ai/schemastery'
import { PromptFreeze } from './backend/host.js'
export const name = 'prompt-freeze'
export const inject = ['agents', 'sessions', 'sessionQuery', 'systemPrompt', 'tools']
export const Config = z.object({ directory: z.string(), autoApplyBelow: z.string().default('24K').description('Automatically apply below this full input token estimate (K=1000, M=1000000). Empty disables.'), nonInteractive: z.union(['auto-keep', 'block']).default('auto-keep').description('Unresolved snapshot recovery in a delegated (subagent) session: auto-keep continues from the saved snapshot and records it, block fails the turn so a user can decide in that session.') })
export function apply(ctx: Context, config: PromptFreezeConfig) { return ctx.plugin(PromptFreeze, config) }
