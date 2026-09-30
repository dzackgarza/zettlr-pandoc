import assert from 'assert'
import { ChildProcess } from 'child_process'
import { subscribe, unsubscribe } from 'diagnostics_channel'
import {
  commandResolves,
  findMissingRequirements,
  preflight,
  REQUIRED_COMMANDS,
  requiredPaths
} from '../source/app/util/preflight'

/** The message type that Node gives the listener of a diagnostics channel. */
type ChannelMessage = Parameters<Parameters<typeof subscribe>[1]>[0]

describe('Startup preflight', function () {
  it('resolves a present command and rejects a missing one', async function () {
    assert.strictEqual(await commandResolves('pandoc'), true)
    assert.strictEqual(await commandResolves('zzz-definitely-not-a-real-command-xyz'), false)
  })

  it('reports every missing command and path, and nothing that is present', async function () {
    const missing = await findMissingRequirements(
      [
        { command: 'pandoc', purpose: 'present' },
        { command: 'zzz-not-a-real-tool', purpose: 'absent tool' }
      ],
      [
        { target: '/definitely/not/a/real/path/xyz', purpose: 'absent file' }
      ]
    )
    assert.strictEqual(missing.length, 2)
    assert.ok(missing.some(m => m.includes('zzz-not-a-real-tool')))
    assert.ok(missing.some(m => m.includes('/definitely/not/a/real/path/xyz')))
    assert.ok(!missing.some(m => m.startsWith('pandoc ')))
  })

  it('fails loud and exits when a requirement is missing', async function () {
    let shown: { title: string, message: string } | undefined
    let exitCode: number | undefined
    const ok = await preflight(
      (title, message) => { shown = { title, message } },
      (code) => { exitCode = code },
      [ { command: 'zzz-not-a-real-tool', purpose: 'absent tool' } ],
      []
    )
    assert.strictEqual(ok, false)
    assert.strictEqual(exitCode, 1)
    assert.ok(shown !== undefined)
    assert.ok(shown.message.includes('zzz-not-a-real-tool'))
  })

  it('passes without side effects when nothing is missing', async function () {
    let showError = false
    let exited = false
    const ok = await preflight(
      () => { showError = true },
      () => { exited = true },
      [ { command: 'pandoc', purpose: 'present' } ],
      []
    )
    assert.strictEqual(ok, true)
    assert.strictEqual(showError, false)
    assert.strictEqual(exited, false)
  })

  it('finds all real required tooling present on this machine', async function () {
    this.timeout(10_000)
    // Integration check: the actual required set must resolve in this
    // environment (documents what the app hard-requires at boot).
    const missing = await findMissingRequirements(REQUIRED_COMMANDS, requiredPaths())
    assert.deepStrictEqual(missing, [])
  })

  it('the production preflight call (default requirements) passes here', async function () {
    this.timeout(10_000)
    // Exactly how environment-check.ts invokes it: no requirement overrides.
    let failed = false
    const ok = await preflight(() => { failed = true }, () => { failed = true })
    assert.strictEqual(ok, true)
    assert.strictEqual(failed, false)
  })

  it('the production preflight starts every tool check before one of them ends', async function () {
    this.timeout(10_000)
    // Node publishes each started process on its `child_process` diagnostics
    // channel (https://nodejs.org/api/diagnostics_channel.html#child-process).
    // The channel message comes before the process has its command name.
    const events: Array<{ kind: 'start'|'end', tool: ChildProcess }> = []
    const record = (message: ChannelMessage): void => {
      assert.ok(typeof message === 'object' && message !== null && 'process' in message)
      assert.ok(message.process instanceof ChildProcess)
      const tool = message.process
      events.push({ kind: 'start', tool })
      tool.once('close', () => events.push({ kind: 'end', tool }))
    }
    subscribe('child_process', record)
    try {
      assert.strictEqual(await preflight(() => {}, () => {}), true)
    } finally {
      unsubscribe('child_process', record)
    }
    const order = events.map(({ kind, tool }) => `${kind} ${tool.spawnfile}`)

    // The presence check of each required command, then the two version
    // reads of the pandoc-crossref compatibility gate.
    const checks = [ ...REQUIRED_COMMANDS.map(({ command }) => command), 'pandoc-crossref', 'pandoc' ]
    assert.deepStrictEqual(order.slice(0, checks.length), checks.map(command => `start ${command}`))
    assert.deepStrictEqual(
      order.slice(checks.length).sort(),
      checks.map(command => `end ${command}`).sort()
    )
  })
})
