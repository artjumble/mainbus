// Electron main for scripts/icons-preview.mjs: one hidden window at 1 device pixel per CSS pixel, so the preview
// sheets show icons at their real pixel sizes. The script drives it with Playwright.
const { app, BrowserWindow } = require('electron')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(() => {
  new BrowserWindow({ show: false, width: 1600, height: 900 }).loadURL('about:blank')
})
