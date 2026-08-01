/**
 * Issue #52's defect was file arguments disappearing somewhere along the
 * desktop launch chain:
 *
 *   .desktop Exec=%F -> zettlr-pandoc-dev -> zettlr-pandoc-boot
 *     -> just launch-desktop -> electron-forge start -- -> Electron
 *
 * Walk the cold-start chain link by link, replacing only the next external
 * program with an argv recorder. This proves shell quoting at each owned
 * handoff without pretending a helper-level assertion is an app launch.
 */
import assert from 'assert'
import { execFile } from 'child_process'
import { realpathSync } from 'fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const REPO = realpathSync(process.cwd())
const DESKTOP = path.join(REPO, 'scripts', 'desktop')
const FILES = [
  '/tmp/zettlr chain probe/one two.md',
  '/tmp/zettlr chain probe/three.md'
]

async function writeExecutable (file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body)
  await chmod(file, 0o755)
}

async function writeRecorder (file: string, record: string, tail = 'exit 0'): Promise<void> {
  await writeExecutable(
    file,
    `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >> ${quote(record)}\n${tail}\n`
  )
}

async function readRecord (record: string): Promise<string[]> {
  return (await readFile(record, 'utf8')).split('\0').slice(0, -1)
}

function quote (value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function run (file: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO): Promise<void> {
  try {
    await execFileAsync(file, args, { env, cwd })
  } catch (err) {
    const failure = err as { code?: number | string, stdout?: string, stderr?: string }
    throw new Error(
      `${file} exited with ${String(failure.code)}\n` +
      `--- stdout ---\n${failure.stdout ?? ''}\n--- stderr ---\n${failure.stderr ?? ''}`
    )
  }
}

describe('Desktop launcher argument chain (#52)', function () {
  it('the desktop entry asks for every file the user selected', async function () {
    const entry = await readFile(path.join(DESKTOP, 'zettlr-pandoc.desktop.in'), 'utf8')
    const exec = entry.split('\n').find(line => line.startsWith('Exec='))
    assert.ok(exec !== undefined, 'The desktop entry has no Exec line')
    assert.ok(exec.endsWith(' %F'), `Exec does not end in the %F field code: ${exec}`)
  })

  it('the wrapper hands every file to the boot script', async function () {
    const home = await mkdtemp(path.join(os.tmpdir(), 'zettlr-chain-wrapper-'))
    const shims = path.join(home, 'shims')
    const record = path.join(home, 'kitty-argv')
    const boot = path.join(home, '.local', 'bin', 'zettlr-pandoc-boot')
    await writeRecorder(path.join(shims, 'kitty'), record)
    await writeExecutable(path.join(shims, 'hyprctl'), `#!/usr/bin/env bash
if [[ "$1" == clients ]]; then printf '[{"class":"zpandoc-boot","address":"0x1"}]'; fi
exit 0
`)
    await writeExecutable(boot, '#!/bin/sh\nexit 0\n')

    await run(path.join(DESKTOP, 'zettlr-pandoc-dev'), FILES, {
      ...process.env,
      HOME: home,
      PATH: `${shims}:${process.env.PATH ?? ''}`
    })

    const argv = await readRecord(record)
    assert.deepStrictEqual(argv.slice(-1 - FILES.length), [boot, ...FILES])
  })

  it('a cold boot forwards every file to `just launch-desktop`', async function () {
    const home = await mkdtemp(path.join(os.tmpdir(), 'zettlr-chain-boot-'))
    const shims = path.join(home, 'shims')
    const record = path.join(home, 'direnv-argv')
    await writeRecorder(path.join(shims, 'direnv'), record, 'sleep 3')
    await writeExecutable(path.join(shims, 'hyprctl'), `#!/usr/bin/env bash
if [[ "$1" == clients ]]; then
  if [[ -e ${quote(record)} ]]; then
    printf '[{"class":"zettlr-pandoc","address":"0x1"}]'
  else
    printf '[]'
  fi
fi
exit 0
`)
    await writeExecutable(path.join(home, '.pandoc', 'bin', 'generate-mathjax-config.py'), '')

    await run(path.join(DESKTOP, 'zettlr-pandoc-boot'), FILES, {
      ...process.env,
      HOME: home,
      // The real boot script is launched inside the kitty splash. Give this
      // recorder-backed test the same terminal capability; otherwise a CI
      // environment with TERM=dumb makes the cosmetic `tput civis` command
      // abort the shell before the owned argument handoff runs.
      TERM: 'xterm',
      PATH: `${shims}:${process.env.PATH ?? ''}`
    })

    assert.deepStrictEqual(
      await readRecord(record),
      ['exec', REPO, 'just', 'launch-desktop', ...FILES]
    )
  })

  it('`just launch-desktop` forwards every file to electron-forge after `--`', async function () {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'zettlr-chain-just-'))
    const record = path.join(sandbox, 'forge-argv')
    await copyFile(path.join(REPO, 'justfile'), path.join(sandbox, 'justfile'))
    await writeRecorder(path.join(sandbox, 'node_modules', '.bin', 'electron-forge'), record)
    await writeExecutable(path.join(sandbox, 'scripts', 'assert-dev-server-stopped.py'), '')
    await writeExecutable(path.join(sandbox, 'shims', 'bun'), '#!/bin/sh\nexit 0\n')

    await run('just', ['launch-desktop', ...FILES], {
      ...process.env,
      PATH: `${path.join(sandbox, 'shims')}:${process.env.PATH ?? ''}`
    }, sandbox)

    assert.deepStrictEqual(await readRecord(record), ['start', '--', ...FILES])
  })
})
