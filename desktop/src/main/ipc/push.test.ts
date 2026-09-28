import { describe, expect, it, vi } from 'vitest'
import { CONTRACT } from '@shared/ipc'
import { sendPush } from './push'

describe('sendPush', () => {
  it("sends the door's channel with its payload, or none for a void push, and nothing without a target", () => {
    const to = { send: vi.fn() }
    sendPush(to, CONTRACT.menu.onOpenRoot, '/v')
    sendPush(to, CONTRACT.menu.onSearch)
    sendPush(undefined, CONTRACT.menu.onSearch)
    expect(to.send.mock.calls).toEqual([[CONTRACT.menu.onOpenRoot.channel, '/v'], [CONTRACT.menu.onSearch.channel]])
  })
})
