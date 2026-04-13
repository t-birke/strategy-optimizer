#!/usr/bin/env node
/**
 * Capture a screenshot from TradingView Desktop via CDP.
 *
 * Requires: TradingView Desktop running with --remote-debugging-port=9222
 *
 * Usage:
 *   node tools/tv-screenshot.js                  # full page screenshot
 *   node tools/tv-screenshot.js chart            # chart area only
 *   node tools/tv-screenshot.js strategy_tester  # strategy tester panel only
 *   node tools/tv-screenshot.js full my-name     # with custom filename
 *
 * Screenshots are saved to the screenshots/ directory.
 *
 * Origin: tradingview-mcp-jackson/src/core/capture.js (adapted for this repo)
 */
import CDP from 'chrome-remote-interface';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const region = process.argv[2] || 'full';
const customName = process.argv[3];
const SCREENSHOT_DIR = resolve(import.meta.dirname, '..', 'screenshots');

mkdirSync(SCREENSHOT_DIR, { recursive: true });

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target found. Is TV Desktop running with --remote-debugging-port=9222?'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();
await c.Page.enable();

async function evaluate(expr) {
  const res = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
  return res.result?.value;
}

let clip = undefined;

if (region === 'chart') {
  const bounds = await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="pane-canvas"]')
        || document.querySelector('[class*="chart-container"]')
        || document.querySelector('canvas');
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()
  `);
  if (bounds) clip = { ...bounds, scale: 1 };
} else if (region === 'strategy_tester') {
  const bounds = await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="backtesting"]')
        || document.querySelector('[class*="strategyReport"]');
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()
  `);
  if (bounds) clip = { ...bounds, scale: 1 };
}

const params = { format: 'png' };
if (clip) params.clip = clip;

const { data } = await c.Page.captureScreenshot(params);
const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
const fname = customName || `tv_${region}_${ts}`;
const filePath = resolve(SCREENSHOT_DIR, `${fname}.png`);
writeFileSync(filePath, Buffer.from(data, 'base64'));

const sizeKb = Math.round(Buffer.from(data, 'base64').length / 1024);
console.log(`Screenshot saved: ${filePath} (${sizeKb} KB, region=${region})`);

await c.close();
