'use strict'

const { app, BrowserWindow } = require('electron')
const { writeFile } = require('fs/promises')
const path = require('path')

const outputFile = process.argv.at(-3)
const screenshotFile = process.argv.at(-2)
const resultFile = process.argv.at(-1)

app.setPath('userData', path.join(path.dirname(screenshotFile), 'user-data'))

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { offscreen: true },
  })

  await window.loadFile(outputFile)
  await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000
      const inspect = () => {
        if (document.querySelectorAll('mjx-container').length === 2) {
          resolve()
        } else if (Date.now() >= deadline) {
          reject(new Error('MathJax render timed out'))
        } else {
          setTimeout(inspect, 50)
        }
      }
      inspect()
    })
  `)

  const html = await window.webContents.executeJavaScript('document.documentElement.outerHTML')
  const screenshot = await window.webContents.capturePage()
  await writeFile(screenshotFile, screenshot.toPNG())
  await writeFile(resultFile, html)
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
