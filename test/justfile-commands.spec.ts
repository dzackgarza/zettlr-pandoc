import { strict as assert } from 'assert'
import {
  discoverJustfileCommands,
  type CapturedCommand,
  type CommandRunner
} from 'source/app/util/justfile-commands'
import { justRecipeCommand, kittyArguments } from 'source/app/util/kitty-launch'
import { parseJustArguments } from 'source/win-main/launcher/just-arguments'
import { justRecipeLabel } from 'source/win-main/launcher/launcher-rows'

function result (stdout = '', stderr = '', code = 0): CapturedCommand {
  return { code, stdout, stderr }
}

describe('Justfile command discovery', function () {
  it('deduplicates Git roots, keeps only public top-level recipes, and preserves recipe metadata', async function () {
    const calls: Array<{ command: string, args: readonly string[], cwd?: string }> = []
    const runner: CommandRunner = async (command, args, cwd) => {
      calls.push({ command, args, cwd })
      if (command === 'git') {
        const workspace = args[1]
        if (workspace === '/outside') {
          return result('', 'not a git repository', 128)
        }
        return result('/repo\n')
      }
      assert.equal(command, 'just')
      assert.equal(cwd, '/repo')
      return result(JSON.stringify({
        source: '/repo/Justfile',
        recipes: {
          build: {
            name: 'build',
            doc: 'Build the project',
            private: false,
            attributes: [{ group: 'dev' }],
            parameters: [{
              name: 'target', kind: 'singular', default: 'all', flag: false,
              value: null, long: 'target', short: null, multiple: false,
              min: null, max: null, help: 'build target'
            }]
          },
          secret: {
            name: 'secret', doc: null, private: true, attributes: [], parameters: []
          },
          test: {
            name: 'test', doc: null, private: false, attributes: [], parameters: []
          }
        }
      }))
    }

    const discovered = await discoverJustfileCommands(
      [ '/repo/docs', '/repo/src', '/outside' ],
      runner
    )

    assert.deepEqual(discovered, [{
      repoRoot: '/repo',
      repoLabel: 'repo',
      justfilePath: '/repo/Justfile',
      recipes: [
        {
          name: 'build',
          doc: 'Build the project',
          group: 'dev',
          parameters: [{
            name: 'target',
            kind: 'singular',
            hasDefault: true,
            flag: false,
            hasValue: false,
            long: 'target',
            short: null,
            multiple: false,
            min: null,
            max: null,
            help: 'build target'
          }]
        },
        { name: 'test', doc: null, group: null, parameters: [] }
      ]
    }])
    assert.equal(calls.filter(call => call.command === 'just').length, 1, 'the same Git root is dumped once')
  })

  it('rejects a Justfile discovered below the repository root', async function () {
    const diagnostics: string[] = []
    const runner: CommandRunner = async command => command === 'git'
      ? result('/repo\n')
      : result(JSON.stringify({ source: '/repo/sub/justfile', recipes: {} }))
    assert.deepEqual(
      await discoverJustfileCommands([ '/repo/sub' ], runner, message => diagnostics.push(message)),
      []
    )
    assert.ok(diagnostics.some(message => message.includes('non-top-level Justfile')))
  })
})

describe('Just recipe launcher argv', function () {
  it('parses quoted arguments without evaluating shell syntax', function () {
    assert.deepEqual(
      parseJustArguments('alpha "two words" a\\ b *.md $HOME'),
      [ 'alpha', 'two words', 'a b', '*.md', '$HOME' ]
    )
    assert.throws(() => parseJustArguments('alpha | cat'), /shell operators/)
    assert.throws(() => parseJustArguments('alpha # comment'), /shell operators/)
  })

  it('builds a direct Just argv and a held kitty command without a shell', function () {
    const command = justRecipeCommand('/repo', 'build', [ '--target', 'docs site' ])
    assert.deepEqual(command, [
      'just', '--ceiling', '/repo', '--one', 'build', '--target', 'docs site'
    ])
    assert.deepEqual(
      kittyArguments('/repo', command),
      [ '--detach', '--directory', '/repo', '--hold', ...command ]
    )
  })

  it('renders positional, option, variadic, and optional parameters in a recipe label', function () {
    assert.equal(justRecipeLabel({
      name: 'build',
      doc: null,
      group: null,
      parameters: [
        {
          name: 'target', kind: 'singular', hasDefault: false, flag: false,
          hasValue: false, long: null, short: null, multiple: false,
          min: null, max: null, help: null
        },
        {
          name: 'profile', kind: 'singular', hasDefault: true, flag: false,
          hasValue: false, long: 'profile', short: null, multiple: false,
          min: null, max: null, help: null
        },
        {
          name: 'files', kind: 'plus', hasDefault: false, flag: false,
          hasValue: false, long: null, short: null, multiple: false,
          min: null, max: null, help: null
        }
      ]
    }), 'build <target> [--profile <profile>] <files>…')
  })
})
