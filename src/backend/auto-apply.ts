import type { Agent, PromptAssembly, UserMessage } from './types.js'
import { renderPrompt, renderContextSections, joinContextSections } from '@deepseek-ai/dsh-system-prompt'

export function parseThreshold(value: string = ''): number | null {
  if (typeof value !== 'string') throw new Error('autoApplyBelow must be a string')
  if (!value.trim()) return null
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(value.trim())
  const tokens = match && Number(match[1]) * (({ k: 1000, m: 1000000 } as Record<string, number>)[match[2].toLowerCase()] ?? 1)
  if (tokens === null || !Number.isSafeInteger(tokens) || tokens <= 0) throw new Error('autoApplyBelow must be a positive whole token count, optionally suffixed K or M')
  return tokens
}

// Full-request text heuristic, not historical usage or provider billing tokens.
// Unknown media fails closed rather than silently counting only its text.
export function estimateInput(agent: Agent, assembly: PromptAssembly | undefined, batch: UserMessage[], notice?: UserMessage): number {
  if (!assembly || typeof agent.session.deriveMessages !== 'function') throw new Error('Candidate request is unavailable')
  const retained = agent.session.deriveMessages()
  // Estimation also synthesizes identity-free framing messages, not durable log nodes.
  const messages: { role: string; id?: string; source?: { kind: string }; content: readonly { type: string; text?: string; content?: unknown }[] }[] = [...retained, ...batch]
  const sections = renderContextSections(assembly)
  const context = joinContextSections(sections)
  const lastContext = messages.findLast(m => m.source?.kind === 'runtime-context')
  const previous = lastContext?.content?.map(b => b.text ?? '').join('')
  const text = context || (lastContext ? 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.' : '')
  if (text && previous !== text) messages.push({ role: 'user', content: [{ type: 'text', text }] })
  if (notice && !messages.some(m => m.id === notice.id)) messages.push(notice)
  const system = renderPrompt(assembly)
  const lastSystem = messages.findLast(m => m.role === 'system' && m.content?.length)
  if (lastSystem?.content?.map(b => b.text ?? '').join('') !== system) messages.unshift({ role: 'system', content: [{ type: 'text', text: system }] })
  for (const message of messages) {
    if (!Array.isArray(message.content) || message.content.some(b => !['text', 'reasoning', 'tool-call', 'tool-result', 'tool-addition', 'tool-removal'].includes(b.type))) throw new Error('Unknown or multimodal input cannot be estimated safely')
    for (const b of message.content) if (b.type === 'tool-result' && Array.isArray(b.content) && b.content.some((c: unknown) => (c as { type?: unknown }).type !== 'text')) throw new Error('Multimodal tool result cannot be estimated safely')
  }
  // Retain old system nodes conservatively: the future route may append an
  // in-history update rather than replacing them. ASCII ~4 chars/token; non-ASCII
  // one code point/token. JSON metadata and framing deliberately add headroom.
  const serialized = JSON.stringify({ messages, tools: assembly.tools ?? [] })
  let nonAscii = 0
  for (const character of serialized) if (character.codePointAt(0)! > 127) nonAscii++
  return Math.ceil((serialized.length - nonAscii) / 4 + nonAscii) + messages.length * 16 + 64
}
