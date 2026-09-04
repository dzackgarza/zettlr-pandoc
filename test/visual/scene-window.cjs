'use strict'

// The Electron application every visual capture drives. Playwright's
// _electron.launch() attaches to THIS binary — the same Electron the app
// ships — so a capture's pixels come from the shipping Chromium rather than
// from a separately downloaded browser. Everything a scene actually does
// (navigate, evaluate, resize, screenshot) is Playwright's job; this file
// exists only because _electron.launch needs an app to launch.
//
// The window loads about:blank before anything else: Playwright surfaces a
// page target only once it has navigated, so a BrowserWindow that has loaded
// nothing never reaches firstWindow().

const { app, BrowserWindow } = require('electron')

const userData = process.env.VISUAL_SCENE_USER_DATA
if (userData !== undefined) {
  app.setPath('userData', userData)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: Number(process.env.VISUAL_SCENE_WIDTH),
    height: Number(process.env.VISUAL_SCENE_HEIGHT),
    show: false,
    // Offscreen rendering keeps the framebuffer — and so every screenshot's
    // dimensions — independent of the X server the capture runs against.
    webPreferences: { offscreen: true }
  })
  await window.loadURL('about:blank')
})
