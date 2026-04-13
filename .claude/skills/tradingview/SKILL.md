---
name: tradingview
description: Use when interacting with TradingView Desktop — pushing/pulling Pine scripts, reading metrics, taking screenshots, creating new scripts, or any CDP-based TradingView automation. Covers all tools in tools/ directory.
---

# TradingView Desktop Tools

All tools live in `tools/` and connect to TradingView Desktop via CDP (Chrome DevTools Protocol) on `localhost:9222`.

**Prerequisite:** TradingView Desktop must be running with remote debugging:
```bash
open -a "TradingView" --args --remote-debugging-port=9222
```

## Available Tools

### pine-push.js — Push Pine source into TV editor

Replaces the **current editor content** with a local `.pine` file, compiles, and reports errors.

```bash
node tools/pine-push.js                        # default: pine/jm_simple_3tp.pine
node tools/pine-push.js pine/my_script.pine    # specific file
```

**CRITICAL WARNING:** This tool calls `editor.setValue()` which **OVERWRITES** whatever is currently open in the Pine Editor. It does NOT create a new script. If you need a new script, you MUST create one first (see "Creating a New Script" below), then push into the blank editor.

### pine-pull.js — Pull Pine source from TV editor

Reads the current Pine Editor content and saves it locally.

```bash
node tools/pine-pull.js                        # default: pine/jm_simple_3tp.pine
node tools/pine-pull.js pine/snapshot.pine     # specific output file
```

Use this to snapshot the current editor before making changes.

### tv-metrics.js — Read strategy performance metrics

Returns JSON with netProfit, totalTrades, percentProfitable, profitFactor, maxDrawDown, sharpeRatio, sortinoRatio, etc.

```bash
node tools/tv-metrics.js            # compact JSON
node tools/tv-metrics.js --pretty   # pretty-printed
```

Requires a strategy to be loaded on the chart.

### tv-inputs.js — Dump strategy input IDs and values

Shows the mapping of input IDs (`in_0`, `in_1`, ...) to names and current values.

```bash
node tools/tv-inputs.js             # formatted table
node tools/tv-inputs.js --json      # raw JSON
```

Useful for verifying input mapping after adding/reordering Pine inputs.

### tv-screenshot.js — Capture screenshots

```bash
node tools/tv-screenshot.js                    # full page
node tools/tv-screenshot.js chart              # chart area only
node tools/tv-screenshot.js strategy_tester    # strategy tester panel
node tools/tv-screenshot.js full my-name       # custom filename
```

Saves to `screenshots/` directory (auto-created).

### tv-bars.js — Extract OHLC bar data

```bash
node tools/tv-bars.js                                  # default date range
node tools/tv-bars.js --from 2024-01-01 --to 2024-06-01 --limit 500
```

Extracts candle data from the chart via the internal TradingView widget API.

## Creating a New Script in TradingView

**NEVER use pine-push.js to create a new script.** It overwrites the current editor.

To create a genuinely new script via CDP:

1. **Open the name dropdown:** Click the `nameButton` element (class contains `nameButton`) in the Pine Editor toolbar
2. **Navigate the menu:** Hover "Create new" to reveal the submenu, then click "Indicator", "Strategy", or "Library"
3. **Verify:** The editor should show a blank template (e.g., `//@version=6 indicator("My script")`) and the name button should show "Untitled script"
4. **Push source:** NOW use `pine-push.js` or `editor.setValue()` to inject your code
5. **Save:** Send Cmd+S via `Input.dispatchKeyEvent`
6. **Rename:** Click nameButton again, click "Rename...", set the name using the native input value setter (React requires `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`), then click "Save"

Keyboard shortcuts (must focus the editor first):
- **Cmd+I** — Create new Indicator
- **Cmd+K, Cmd+S** — Create new Strategy
- **Cmd+K, Cmd+I** — (same as Cmd+I in some versions)

**Important CDP notes:**
- Use `Input.dispatchMouseEvent` for real clicks (not `element.click()`) when interacting with menus — some TradingView menus don't respond to synthetic `.click()` calls
- Menu items are found by walking the DOM for text content matches (e.g., `el.textContent.trim() === 'Rename...'`)
- The React fiber traversal to find the Monaco editor walks **parent elements** first (`el.parentElement`), looking for keys starting with `__reactFiber$`, then walks `node.return` up the fiber tree checking `memoizedProps.value.monacoEnv`
- For renaming, use the native HTMLInputElement value setter to bypass React's controlled input: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, newName)` followed by dispatching `input` and `change` events

## Listing Saved Scripts

Fetch from the Pine Facade API (must be called from the page context for cookies):
```js
// Via CDP Runtime.evaluate (awaitPromise: true)
fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', {credentials:'include'})
  .then(r => r.json())
  .then(data => data.map(s => s.scriptName))
```

## Pine Script Files

Local Pine scripts are stored in the `pine/` directory. Current files:
!`ls -1 pine/*.pine 2>/dev/null`
