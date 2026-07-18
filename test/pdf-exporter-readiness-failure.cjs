require('tsx/cjs')

const { spawn } = require('child_process')
const { BrowserWindow, app } = require('electron')
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

  try {
    await exportSimplePdf(
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
  } catch (error) {
    await new Promise(resolve => setImmediate(resolve))
    process.stdout.write(`${error.message}:${BrowserWindow.getAllWindows().length}`)
    app.quit()
    return
  }

  process.stdout.write('unexpected-success')
  app.quit()
}

main().catch(error => {
  console.error(error)
  app.exit(1)
})
