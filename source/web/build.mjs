import { build } from "esbuild";
import fs from "fs";
const cfgPath = process.argv[2] || "config.json";
const cfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : '{"apiKey":"PASTE"}';
const r = await build({ entryPoints: ["src/app.js"], bundle: true, minify: true, format: "iife", target: "es2019", write: false });
const js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = fs.readFileSync("src/style.css", "utf8");
const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#F6F5F1"><title>Pantry Pals</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>${css}</style></head><body><div id="app"></div><div id="toast"></div>
<script>window.FIREBASE_CONFIG=${cfg};</script><script>${js}</script></body></html>`;
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/index.html", html);
console.log("ok", (html.length/1024).toFixed(0)+"KB");
