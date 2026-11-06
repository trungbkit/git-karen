import { describe, expect, it } from 'vitest'
import type { AiStatus } from '@shared/types'
import { DEFAULT_TASK_MODEL, initialModel, modelOptions, withUserNotes } from './aiTask'

const status = (provider: 'anthropic' | 'openai', model: string) => ({ active: { provider, model, credential: 'anthropicApiKey' } }) as unknown as AiStatus

describe('AI task options', () => {
  it('starts Anthropic tasks on Opus 5.5', () => {
    expect(initialModel(status('anthropic', 'claude-haiku-5-5'), null)).toBe(DEFAULT_TASK_MODEL)
    expect(DEFAULT_TASK_MODEL).toBe('claude-opus-5-5')
  })

  it('keeps the configured model on other providers, and a remembered pick everywhere', () => {
    expect(initialModel(status('openai', 'gpt-x'), null)).toBe('gpt-x')
    expect(initialModel(status('anthropic', 'claude-haiku-5-5'), 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(initialModel(null, 'claude-sonnet-5-5')).toBe('')
  })

  it('offers the configured model when it is not a known one', () => {
    expect(modelOptions(status('anthropic', 'claude-haiku-5-5')).map((m) => m.id)).toContain('claude-opus-5-5')
    expect(modelOptions(status('anthropic', 'my-gateway-model')).at(-1)?.id).toBe('my-gateway-model')
    expect(modelOptions(status('openai', 'gpt-x')).map((m) => m.id)).toEqual(['gpt-x'])
    expect(modelOptions(null)).toEqual([])
  })

  it('appends the user notes after the prompt', () => {
    expect(withUserNotes('P', '  ')).toBe('P')
    const out = withUserNotes('P\n## Reply format\nX', ' keep the new API ')
    expect(out.startsWith('P\n## Reply format\nX\n\n## Additional instructions from the user\nkeep the new API\n')).toBe(true)
    expect(out).toContain('keep the reply format')
  })
})
