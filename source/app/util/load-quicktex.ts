import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { QuickTexCatalogue } from '@dts/common/quicktex'

const execFileAsync = promisify(execFile)

function vimQuote (value: string): string {
  return value.replaceAll("'", "''")
}

/**
 * Sources QuickTeX and the user's Vimscript in Neovim, then exports the two
 * dictionaries through Vim's own keytrans(). Zettlr never parses Vimscript.
 */
export async function loadQuickTex (
  configFile: string,
  pluginDirectory: string
): Promise<QuickTexCatalogue> {
  const pluginScript = path.join(pluginDirectory, 'plugin', 'quicktex.vim')
  const lua = [
    'local function tx(t)',
    '  local out = {}',
    '  for k, v in pairs(t or {}) do',
    "    if type(v) == 'string' then out[k] = vim.fn.keytrans(v) end",
    '  end',
    '  return out',
    'end',
    "local data = { prose = tx(vim.g.quicktex_prose or {}), math = tx(vim.g.quicktex_math or {}), excludeChars = vim.g.quicktex_excludechar or {'{', '(', '['} }",
    'print(vim.json.encode(data))'
  ].join(' ')

  const { stdout, stderr } = await execFileAsync('nvim', [
    '--headless', '-u', 'NONE', '-n',
    '-c', `execute 'set runtimepath+=' . fnameescape('${vimQuote(pluginDirectory)}')`,
    '-c', `execute 'source ' . fnameescape('${vimQuote(pluginScript)}')`,
    '-c', `execute 'source ' . fnameescape('${vimQuote(configFile)}')`,
    '-c', `lua ${lua}`,
    '-c', 'qa!'
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })

  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const json = [...lines].reverse().find(line => line.startsWith('{') && line.endsWith('}'))
  if (json === undefined) {
    throw new Error(`Couldn't load QuickTeX definitions from ${configFile}.${stderr.trim() === '' ? '' : ` ${stderr.trim()}`}`)
  }

  const parsed = JSON.parse(json) as {
    prose?: Record<string, string>
    math?: Record<string, string>
    excludeChars?: string[]
  }
  return {
    prose: parsed.prose ?? {},
    math: parsed.math ?? {},
    excludeChars: parsed.excludeChars ?? ['{', '(', '['],
    sourceFile: configFile,
    diagnostics: []
  }
}
