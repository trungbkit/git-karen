import { describe, expect, it } from 'vitest'
import { describePrompt } from './askpass'

describe('describePrompt', () => {
  it('reads git HTTPS prompts', () => {
    expect(describePrompt("Username for 'https://github.com': ")).toEqual({ kind: 'username', secret: false, title: 'Sign in to github.com', subject: 'https://github.com' })
    expect(describePrompt("Password for 'https://alice@gitlab.example.com:8443': ")).toEqual({
      kind: 'password',
      secret: true,
      title: 'Password for gitlab.example.com',
      subject: 'https://alice@gitlab.example.com:8443'
    })
  })

  it('reads ssh prompts', () => {
    expect(describePrompt("Enter passphrase for key '/Users/a/.ssh/id_ed25519': ")).toMatchObject({ kind: 'passphrase', secret: true, subject: '/Users/a/.ssh/id_ed25519' })
    expect(describePrompt('Enter passphrase: ')).toMatchObject({ kind: 'passphrase', secret: true, subject: null })
    expect(describePrompt("git@example.com's password: ")).toMatchObject({ kind: 'password', secret: true, subject: 'git@example.com' })
  })

  it('recognises the host key question, with or without the confirm hint', () => {
    const prompt =
      "The authenticity of host 'github.com (140.82.112.3)' can't be established.\nED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "
    expect(describePrompt(prompt)).toEqual({ kind: 'hostKey', secret: false, title: 'Trust this SSH server?', subject: 'github.com (140.82.112.3)' })
    expect(describePrompt(prompt, 'confirm').kind).toBe('hostKey')
  })

  it('follows ssh hints and hides anything it does not know', () => {
    expect(describePrompt('Allow use of key?', 'confirm').kind).toBe('confirm')
    expect(describePrompt('Confirm user presence for key ED25519-SK', 'none')).toMatchObject({ kind: 'notice', secret: false })
    expect(describePrompt('Verification code: ')).toMatchObject({ kind: 'text', secret: true })
  })
})
