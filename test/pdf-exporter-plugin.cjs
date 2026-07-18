require('tsx/cjs')

const { spawn } = require('child_process')
const { app } = require('electron')
const { plugin: exportSimplePdf } = require('../source/app/service-providers/commands/exporter/pdf-exporter.ts')

async function runPandoc (defaultsFile) {
  return await new Promise((resolve, reject) => {
    const pandoc = spawn('pandoc', [ '--defaults', defaultsFile ])
    const stderr = []

    pandoc.stderr.on('data', data => stderr.push(String(data)))
    pandoc.on('error', reject)
    pandoc.on('close', code => resolve({ code: code ?? 1, stdout: [], stderr }))
  })
}

async function main () {
  const [ defaultsFile, inputFile, targetDirectory ] = process.argv.slice(2)
  await app.whenReady()
  app.on('window-all-closed', event => event.preventDefault())

  const output = await exportSimplePdf(
    {
      profile: { name: 'Simple PDF.yaml', reader: 'markdown', writer: 'simple-pdf', isInvalid: false },
      sourceFiles: [ { path: inputFile, name: 'input', ext: '.md' } ],
      targetDirectory
    },
    [ inputFile ],
    {
      listDefaults: async () => [ { name: 'HTML.yaml', reader: 'markdown', writer: 'html', isInvalid: false } ],
      writeDefaults: async () => defaultsFile,
      runPandoc
    }
  )

  await new Promise(resolve => process.stdout.write(`ZETTLR_SIMPLE_PDF_RESULT=${JSON.stringify(output)}`, resolve))
  app.exit()
}

main().catch(error => {
  console.error(error)
  app.exit(1)
})
