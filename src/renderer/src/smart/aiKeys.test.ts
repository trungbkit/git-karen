import { describe, expect, it } from 'vitest'
import { AI_CREDENTIALS, detectCredential, keyProblem } from './aiKeys'

describe('detectCredential', () => {
  it('tells keys apart by prefix', () => {
    expect(detectCredential('sk-ant-oat01-abc')).toBe('anthropicOauthToken')
    expect(detectCredential(' sk-ant-api03-abc ')).toBe('anthropicApiKey')
    expect(detectCredential('sk-proj-abc')).toBe('openaiApiKey')
    expect(detectCredential('sk-abc')).toBe('openaiApiKey')
    expect(detectCredential('AIzaSyabc')).toBe('geminiApiKey')
  })

  it('returns null for keys it does not know', () => {
    expect(detectCredential('')).toBeNull()
    expect(detectCredential('gateway-token-123')).toBeNull()
  })
})

describe('keyProblem', () => {
  it('accepts empty input, matching keys and unknown formats', () => {
    expect(keyProblem('openaiApiKey', '')).toBeNull()
    expect(keyProblem('openaiApiKey', 'sk-proj-abc')).toBeNull()
    expect(keyProblem('anthropicApiKey', 'gateway-token')).toBeNull()
  })

  it('flags a key for another provider', () => {
    expect(keyProblem('openaiApiKey', 'sk-ant-api03-abc')).toBe('This looks like an Anthropic API key.')
    expect(keyProblem('anthropicApiKey', 'sk-ant-oat01-abc')).toBe('This looks like a Claude OAuth token.')
  })

  it('flags whitespace inside a key', () => {
    expect(keyProblem('geminiApiKey', 'AIza abc')).toMatch(/spaces/)
  })

  it('lists every credential once', () => {
    expect(new Set(AI_CREDENTIALS.map((c) => c.id)).size).toBe(4)
  })
})
