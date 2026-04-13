# Tools

CLI utilities for interacting with TradingView Desktop via CDP (Chrome DevTools Protocol).

All tools require TradingView Desktop running with remote debugging enabled:

```bash
# macOS — add to TV Desktop launch args or use the launch script:
open -a "TradingView" --args --remote-debugging-port=9222

# Or use the launch script from tradingview-mcp-jackson:
~/dev/trading/tradingview-mcp-jackson/scripts/launch_tv_debug_mac.sh
```

Dependency: `chrome-remote-interface` (already in package.json).

---

## pine-push.js

Push a local `.pine` file into TradingView's Pine Editor, compile, and report errors.

```bash
node tools/pine-push.js                          # default: pine/jm_simple_3tp.pine
node tools/pine-push.js pine/jm_simple.pine      # push a different file
```

**Prerequisite:** The Pine Editor panel must be open in TradingView (bottom panel).

**How it works:** Finds the Monaco editor instance via React fiber tree traversal,
calls `setValue()` to replace the source, then clicks the compile/save button and
reads back any Monaco markers (errors).

---

## pine-pull.js

Pull the current source from TradingView's Pine Editor and save it locally.

```bash
node tools/pine-pull.js                          # default: pine/jm_simple_3tp.pine
node tools/pine-pull.js pine/snapshot.pine        # save to a different file
```

**Prerequisite:** Pine Editor panel must be open.

Useful for snapshotting whatever is currently in TV before making local edits.

---

## tv-metrics.js

Read strategy performance metrics from the Strategy Tester panel.

```bash
node tools/tv-metrics.js                # compact JSON
node tools/tv-metrics.js --pretty       # pretty-printed
```

Returns: `netProfit`, `totalTrades`, `percentProfitable`, `profitFactor`,
`maxDrawDown`, `sharpeRatio`, `sortinoRatio`, etc.

**Prerequisite:** A strategy must be loaded on the chart.

---

## tv-inputs.js

Dump all strategy input IDs, types, names, and current values.

```bash
node tools/tv-inputs.js                 # formatted table
node tools/tv-inputs.js --json          # raw JSON
```

Useful for verifying the CDP input ID mapping (`in_0`, `in_1`, ...) after
adding or reordering Pine inputs. The table output shows which `in_N` maps
to which named input.

**Prerequisite:** JM Simple 3TP strategy must be on the chart.

---

## tv-screenshot.js

Capture a screenshot from TradingView Desktop.

```bash
node tools/tv-screenshot.js                      # full page
node tools/tv-screenshot.js chart                 # chart area only
node tools/tv-screenshot.js strategy_tester       # strategy tester panel
node tools/tv-screenshot.js full my-screenshot    # custom filename
```

Screenshots are saved to `screenshots/` (created automatically).

---

## Origin

These tools are adapted from
[tradingview-mcp-jackson](../../../trading/tradingview-mcp-jackson) (`scripts/`
and `src/core/`). The key technique — finding Monaco via `__reactFiber$` → walking
`memoizedProps.value.monacoEnv` — comes from that project's Pine editor integration.
