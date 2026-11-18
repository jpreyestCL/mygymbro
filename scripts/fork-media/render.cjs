const { chromium } = require('playwright'); const fs = require('fs')
;(async () => {
  const frames = JSON.parse(fs.readFileSync('frames.json')); const b = await chromium.launch()
  const p = await b.newPage({ viewport: { width: 360, height: 360 } })
  for (let i = 0; i < frames.length; i++) { await p.setContent(`<body style="margin:0">${frames[i]}</body>`); await p.screenshot({ path: `f${String(i).padStart(2,'0')}.png` }) }
  await b.close()
})()
