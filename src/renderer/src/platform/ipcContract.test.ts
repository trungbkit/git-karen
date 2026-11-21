// The IPC method names live in two languages: the renderer's allowlists (bridge.ts, shared/gitMethods.ts) and the
// `match method` dispatchers in the Rust backend. A name on one side only fails at runtime with "Unknown method",
// so these tests read the Rust sources and compare the two sets.
import { describe, expect, it } from 'vitest'
import { GIT_METHODS } from '@shared/gitMethods'
import bridgeTs from './bridge.ts?raw'
import serviceRs from '../../../../src-tauri/src/git/service.rs?raw'
import libRs from '../../../../src-tauri/src/lib.rs?raw'
import integrationsRs from '../../../../src-tauri/src/integrations/mod.rs?raw'

/** Method names matched by a Rust dispatcher: every `"name" =>` arm from `signature` up to its Unknown-method fallback. */
function rustArms(source: string, signature: string): string[] {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error(`Dispatcher not found: ${signature}`)
  const end = source.indexOf('Unknown method', start)
  if (end < 0) throw new Error(`No Unknown-method fallback after ${signature}`)
  return [...source.slice(start, end).matchAll(/^\s*"(\w+)"\s*=>/gm)].map((m) => m[1])
}

/** Method names the bridge sends through a helper such as `appCall('name', …)`. */
function bridgeCalls(source: string, helper: string): string[] {
  return [...source.matchAll(new RegExp(`\\b${helper}(?:<.*?>)?\\('(\\w+)'`, 'g'))].map((m) => m[1])
}

const sorted = (names: Iterable<string>) => [...new Set(names)].sort()

describe('rustArms', () => {
  const src = `
fn other() { match x { "skip" => 1, _ => 0 } }
pub async fn call(&self, method: &str) {
    match method {
        "one" => a(),
        "two" | "three" => b(),
        "four" => {
            let x = match y { "inner" => 1, _ => 2 };
        }
        _ => Err(format!("Unknown method: {method}")),
    }
}
fn after() { match x { "late" => 1 } }`

  it('takes arms between the signature and the fallback, including nested ones that start a line', () => {
    expect(rustArms(src, 'pub async fn call(')).toEqual(['one', 'four'])
  })

  it('fails loudly when the dispatcher moved', () => {
    expect(() => rustArms(src, 'fn missing(')).toThrow('Dispatcher not found')
  })
})

describe('bridgeCalls', () => {
  it('reads the method name after a helper call, with or without a nested type argument', () => {
    const src = "a: () => appCall('one'), b: () => appCall<Partial<Prefs>>('two', x), c: () => otherCall('no')"
    expect(bridgeCalls(src, 'appCall')).toEqual(['one', 'two'])
  })
})

describe('IPC contract between the renderer and the Rust backend', () => {
  it('lists the same git methods as GitService::call', () => {
    const rust = rustArms(serviceRs, 'pub async fn call(&self, method: &str, args: Vec<Value>)')
    expect(sorted(rust)).toEqual(sorted(Object.keys(GIT_METHODS)))
  })

  it('sends only app methods that app_call handles, and uses all of them', () => {
    expect(sorted(bridgeCalls(bridgeTs, 'appCall'))).toEqual(sorted(rustArms(libRs, 'async fn app_call(')))
  })

  it('matches ai_call', () => {
    expect(sorted(bridgeCalls(bridgeTs, 'aiCall'))).toEqual(sorted(rustArms(libRs, 'async fn ai_call(')))
  })

  it('matches the integrations dispatcher', () => {
    const rust = rustArms(integrationsRs, 'pub async fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, String>')
    expect(sorted(bridgeCalls(bridgeTs, 'hostingCall'))).toEqual(sorted(rust))
  })
})
