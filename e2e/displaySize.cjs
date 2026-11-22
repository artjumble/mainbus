// Prints the primary display's size and work area, for the CI log: `pnpm exec electron e2e/displaySize.cjs`.
const { app, screen } = require('electron')

app.whenReady().then(() => {
  const d = screen.getPrimaryDisplay()
  console.log(`display size ${d.size.width}x${d.size.height}, work area ${d.workAreaSize.width}x${d.workAreaSize.height}, scale ${d.scaleFactor}`)
  app.quit()
})
