import { createElement as h } from 'react'
import type { ClientContext } from './frontend/client-types.js'
import { NS, dictionaries } from './frontend/locales.js'
import { PromptFreezePanel } from './frontend/panel.js'

// Provided by the browser bundle wrapper, not a runtime module dependency.
declare const REMOTE: unknown

export const name = 'prompt-freeze/client'
export const inject = ['slots', 'remote', 'locale']
export async function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'prompt-freeze: dictionaries')
  const unmount = await ctx.remote.$mount(REMOTE)
  ctx.inject(['remote', 'remote.promptFreeze'], child => {
    child.slots.inject('conversation.input.left', () => child.slots.register({ name: 'conversation.input.left', id: 'prompt-freeze', locale: NS, order: -15, inject: () => ({ promptFreezeRemote: child.remote.promptFreeze }) }, props => h(PromptFreezePanel, { ...props, key: props.sessionId })))
  })
  return unmount
}
