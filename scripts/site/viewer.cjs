// Electron main for the marketing site's tooling: one hidden window at 1 device pixel per CSS pixel, which
// screenshots.spec.ts uses to encode the screenshots and site.spec.ts to open the site from file://. Playwright drives
// it, as the e2e tests drive the app, so there is no browser to download.
const { app, BrowserWindow } = require('electron')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(() => {
  new BrowserWindow({ show: false, width: 1440, height: 900 }).loadURL('about:blank')
})
