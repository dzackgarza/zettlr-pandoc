require('tsx/cjs')

const { BrowserWindow, app } = require('electron')
const { waitForPrintableHtmlReadiness } = require('../source/app/service-providers/commands/exporter/pdf-exporter.ts')

async function main () {
  await app.whenReady()

  const printer = new BrowserWindow({ show: false })
  try {
    await printer.loadFile(process.argv[2])
    await waitForPrintableHtmlReadiness(printer.webContents)
    process.stdout.write(await printer.webContents.executeJavaScript('document.documentElement.dataset.readiness'))
  } finally {
    printer.destroy()
    app.quit()
  }
}

main().catch(error => {
  console.error(error)
  app.exit(1)
})
