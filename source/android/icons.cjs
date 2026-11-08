const { chromium } = require("/opt/npm-tools/node_modules/playwright"); const fs=require("fs");
const basket=`<path d="M20 22c0-7 5-12 12-12s12 5 12 12" fill="none" stroke="#1C3B2E" stroke-width="3.5" stroke-linecap="round"/>
<path d="M10 22h44l-4 32a6 6 0 0 1-6 5H20a6 6 0 0 1-6-5z" fill="#3FA374"/><path d="M10 22h44l-1 7H11z" fill="#2F7D5B"/>
<circle cx="25" cy="38" r="3" fill="#10241B"/><circle cx="39" cy="38" r="3" fill="#10241B"/><circle cx="26" cy="37" r="1" fill="#fff"/><circle cx="40" cy="37" r="1" fill="#fff"/>
<path d="M27 45q5 4 10 0" fill="none" stroke="#10241B" stroke-width="2.5" stroke-linecap="round"/><circle cx="20" cy="44" r="3" fill="#F6A6B2"/><circle cx="44" cy="44" r="3" fill="#F6A6B2"/>`;
// legacy: basket fills the square (bbox ~ x8-56, y8.25-59)
const legacy=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="6.5 6.5 51 54">${basket}</svg>`;
// adaptive foreground 108 units, visible ~72 in middle; basket ~68 tall
const fgPad=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-14 -12.4 92 92">${basket}</svg>`;
(async()=>{ const b=await chromium.launch(); const p=await b.newPage();
 const shot=async(svg,s,path)=>{ await p.setViewportSize({width:s,height:s}); await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ','<svg width="'+s+'" height="'+s+'" ')}</body></html>`); await p.screenshot({path,omitBackground:true}); };
 for (const [d,s] of [["mdpi",48],["hdpi",72],["xhdpi",96],["xxhdpi",144],["xxxhdpi",192]]) {
  fs.mkdirSync(`res/mipmap-${d}`,{recursive:true});
  await shot(legacy,s,`res/mipmap-${d}/ic_launcher.png`);
  await shot(fgPad,s*108/48,`res/mipmap-${d}/ic_launcher_fg.png`); }
 await shot(legacy,512,`../icon-preview.png`);
 await b.close(); })();
