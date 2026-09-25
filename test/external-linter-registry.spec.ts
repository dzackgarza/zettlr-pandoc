import { strict as assert } from 'assert'
import {
  registeredExternalLinters,
  registerExternalLinterBackend,
  runExternalLinter
} from 'source/app/util/external-linter-registry'
import type { AppServiceContainer } from 'source/app/app-service-container'

function appStub (): AppServiceContainer {
  return {
    config: {
      getConfig: () => ({
        editor: {
          lint: {
            languageTool: {
              active: true,
              level: 'default',
              motherTongue: '',
              variants: {
                en: 'en-US',
                de: 'de-DE',
                pt: 'pt-PT',
                ca: 'ca-ES'
              },
              ignoredRules: [],
              provider: 'cli',
              customServer: '',
              username: '',
              apiKey: ''
            }
          }
        }
      })
    }
  } as unknown as AppServiceContainer
}

describe('external linter registry', function () {
  this.timeout(30_000)

  it('runs LanguageTool as a registered linter with math projection', async function () {
    const source = 'By the work of AET23, to each diagram one can associated a pair $(Y,C)$ where $Y$ is a surface.'
    const result = await runExternalLinter(appStub(), {
      id: 'language-tool',
      text: source,
      context: {
        active: true,
        language: 'en-US',
        disabledRules: [],
        supportedLanguages: [ 'en-US' ],
        userDictionary: []
      }
    })

    const grammar = result.diagnostics.find(diagnostic =>
      diagnostic.data?.ruleId === 'MD_BASEFORM'
    )
    assert.ok(grammar !== undefined)
    assert.equal(source.slice(grammar.from, grammar.to), 'associated')
    assert.equal(
      result.diagnostics.some(diagnostic => diagnostic.source === 'language-tool(whitespace)'),
      false
    )
  })

  it('preserves sentence continuity across display math', async function () {
    const source = [
      'The boundary lattice associated to $\\eta$ is',
      '',
      '$$\\bdlattice{T}{\\eta}=\\eta^\\perp,$$',
      '',
      'which has signature $(1,n-1)$.'
    ].join('\n')
    const result = await runExternalLinter(appStub(), {
      id: 'language-tool',
      text: source,
      context: {
        active: true,
        language: 'en-US',
        disabledRules: [],
        supportedLanguages: [ 'en-US' ],
        userDictionary: []
      }
    })

    assert.equal(
      result.diagnostics.some(diagnostic =>
        diagnostic.data?.ruleId === 'UPPERCASE_SENTENCE_START'
      ),
      false
    )
    assert.equal(
      result.diagnostics.some(diagnostic => diagnostic.source === 'language-tool(whitespace)'),
      false
    )
  })

  it('rejects unknown linter ids at the registry boundary', async function () {
    await assert.rejects(
      async () => await runExternalLinter(appStub(), {
        id: 'not-a-linter',
        text: 'Text.',
        context: {}
      }),
      /Unknown external linter/u
    )
  })

  it('registers external linters by id and rejects duplicate ids', function () {
    assert.deepEqual(
      registeredExternalLinters(),
      [ 'flowmark', 'language-tool' ]
    )
    assert.throws(
      () => registerExternalLinterBackend({
        id: 'flowmark',
        async run () {
          return { diagnostics: [] }
        }
      }),
      /already registered/u
    )
  })
})
