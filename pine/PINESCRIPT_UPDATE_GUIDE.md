# PineScript Update Guide — JM Simple 3TP

Reference: `pine/jm_simple_3tp.pine` (current) vs `engine/strategy.js` (updated)

---

## Change 0: Add End Date Input & Date Range Filtering

The strategy now accepts an End Date alongside the existing Start Date, so the
backtest window can be precisely controlled via CDP when comparing JS vs TV.

### Current (line 20–21):

```pine
GRP_DATE    = "Date Filter"
i_startDate = input.time(timestamp("2021-04-11"), "Start Date", group=GRP_DATE)
inDateRange = time >= i_startDate
```

### Replace with:

```pine
GRP_DATE    = "Date Filter"
i_startDate = input.time(timestamp("2021-04-11"), "Start Date", group=GRP_DATE)
i_endDate   = input.time(timestamp("2099-12-31"), "End Date",   group=GRP_DATE)
inDateRange = time >= i_startDate and time <= i_endDate
```

Also add end-of-range exit after the time-based exit block to close any open
position once past the end date:

```pine
if time > i_endDate and strategy.position_size != 0
    strategy.close_all(comment="END_DATE")
```

**Important:** Adding `i_endDate` as `in_1` shifts ALL subsequent input IDs
by +1. See the Input ID Reference table below for the new mapping.

---

## Change 1: Add Emergency SL Input

Add after the leverage input (line 43):

```pine
i_leverage  = input.int(1,       "Leverage", minval=1, maxval=20, step=1, group=GRP_RISK)
// ADD THIS LINE:
i_emergSL   = input.int(15,      "Emergency SL %", minval=5, maxval=25, step=1, group=GRP_RISK,
     tooltip="Hard intra-bar stop as % from entry. Circuit-breaker for flash crashes.")
```

This becomes `in_19` in the CDP input mapping (after `i_leverage` which is `in_18`).

---

## Change 2: Add State Variables for Close-Based SL

Add to the `var` block (after line 121):

```pine
var bool  slTriggered  = false    // close crossed SL → exit at next bar's open
```

---

## Change 3: Replace the SL Mechanism in Exit Orders

The current Pine code uses `strategy.exit(..., stop=sl)` which fires **intra-bar**
on a wick. The new behavior:

- **Normal SL**: Only triggers when the candle *closes* beyond the SL level.
  The exit fills at the **next bar's open** via `strategy.close()`.
- **Emergency SL**: Hard intra-bar stop at a fixed % from entry. Uses
  `strategy.exit(..., stop=)` so it fires on wicks. This is the catastrophe
  protection.

### Current code to replace (lines 153–169):

```pine
// Long exits — 3 TPs, SL moves to breakeven after TP1
if strategy.position_size > 0
    float ep = strategy.position_avg_price
    float sl = longTp1 ? ep * 1.003 : ep - longAtr * i_atrSL
    if not longTp1
        strategy.exit("L-TP1", "L", qty_percent=i_tp1Pct, limit=ep + longAtr * i_tp1Mult, stop=sl)
    strategy.exit("L-TP2", "L", qty_percent=i_tp2Pct, limit=ep + longAtr * i_tp2Mult, stop=sl)
    strategy.exit("L-TP3", "L", limit=ep + longAtr * i_tp3Mult, stop=sl)

// Short exits — 3 TPs, SL moves to breakeven after TP1
if strategy.position_size < 0
    float ep = strategy.position_avg_price
    float sl = shortTp1 ? ep * 0.997 : ep + shortAtr * i_atrSL
    if not shortTp1
        strategy.exit("S-TP1", "S", qty_percent=i_tp1Pct, limit=ep - shortAtr * i_tp1Mult, stop=sl)
    strategy.exit("S-TP2", "S", qty_percent=i_tp2Pct, limit=ep - shortAtr * i_tp2Mult, stop=sl)
    strategy.exit("S-TP3", "S", limit=ep - shortAtr * i_tp3Mult, stop=sl)
```

### Replace with:

```pine
// Execute pending SL exit at this bar's open
if slTriggered and strategy.position_size != 0
    if strategy.position_size > 0
        strategy.close("L", comment="SL_CLOSE")
    else
        strategy.close("S", comment="SL_CLOSE")
    slTriggered := false

// Long exits — emergency SL (intra-bar) + 3 TPs (intra-bar, no regular SL)
if strategy.position_size > 0
    float ep = strategy.position_avg_price
    float emergSL = ep * (1 - i_emergSL / 100.0)
    strategy.exit("L-ESL", "L", stop=emergSL, comment="EMERGENCY")
    if not longTp1
        strategy.exit("L-TP1", "L", qty_percent=i_tp1Pct, limit=ep + longAtr * i_tp1Mult)
    strategy.exit("L-TP2", "L", qty_percent=i_tp2Pct, limit=ep + longAtr * i_tp2Mult)
    strategy.exit("L-TP3", "L", limit=ep + longAtr * i_tp3Mult)

// Short exits — emergency SL (intra-bar) + 3 TPs (intra-bar, no regular SL)
if strategy.position_size < 0
    float ep = strategy.position_avg_price
    float emergSL = ep * (1 + i_emergSL / 100.0)
    strategy.exit("S-ESL", "S", stop=emergSL, comment="EMERGENCY")
    if not shortTp1
        strategy.exit("S-TP1", "S", qty_percent=i_tp1Pct, limit=ep - shortAtr * i_tp1Mult)
    strategy.exit("S-TP2", "S", qty_percent=i_tp2Pct, limit=ep - shortAtr * i_tp2Mult)
    strategy.exit("S-TP3", "S", limit=ep - shortAtr * i_tp3Mult)
```

Key differences from the old code:
- `stop=sl` is **removed** from all TP exit calls — TPs are now limit-only.
- Emergency SL (`L-ESL`/`S-ESL`) is a separate `strategy.exit()` with only `stop=`.
- The regular SL is handled by the close-based check below (Change 4).

---

## Change 4: Add Close-Based SL Check

Add **after** the structural exit block (after line 175) and **before** the
time-based exit (line 178). This replaces the intra-bar SL that was removed
from the TP exit calls:

```pine
// Close-based SL: only triggers when candle CLOSES beyond SL level.
// Wicks past SL that recover by close are ignored.
if strategy.position_size > 0 and not slTriggered
    float ep = strategy.position_avg_price
    float sl = longTp1 ? ep * 1.003 : ep - longAtr * i_atrSL
    if close <= sl
        slTriggered := true

if strategy.position_size < 0 and not slTriggered
    float ep = strategy.position_avg_price
    float sl = shortTp1 ? ep * 0.997 : ep + shortAtr * i_atrSL
    if close >= sl
        slTriggered := true
```

---

## Change 5: Guard Entry Signals When SL Is Pending

The current entry code (lines 132–145) needs a guard so we don't enter a new
position while a close-based SL exit is pending:

### Current:

```pine
if goLong and strategy.position_size <= 0 and units > 0
    strategy.entry("L", strategy.long, qty=units)
    ...

if goShort and strategy.position_size >= 0 and units > 0
    strategy.entry("S", strategy.short, qty=units)
    ...
```

### Change to:

```pine
if goLong and strategy.position_size <= 0 and units > 0 and not slTriggered
    strategy.entry("L", strategy.long, qty=units)
    ...

if goShort and strategy.position_size >= 0 and units > 0 and not slTriggered
    strategy.entry("S", strategy.short, qty=units)
    ...
```

---

## Change 6: Reset `slTriggered` on New Entry

When a new entry fills, reset the SL flag. Add to the entry blocks:

```pine
if goLong and strategy.position_size <= 0 and units > 0 and not slTriggered
    strategy.entry("L", strategy.long, qty=units)
    longAtr := atr
    longTp1 := false
    longBar := bar_index
    totalEntries += 1
    slTriggered := false   // ADD THIS

if goShort and strategy.position_size >= 0 and units > 0 and not slTriggered
    strategy.entry("S", strategy.short, qty=units)
    shortAtr := atr
    shortTp1 := false
    shortBar := bar_index
    totalEntries += 1
    slTriggered := false   // ADD THIS
```

---

## Change 7: Update Stats Table

Add emergency SL info to the stats table. Update row 8 (line 272–274):

```pine
// Current:
table.cell(tbl, 1, 8, str.tostring(i_riskPct, "#.#") + "% | " + str.tostring(i_leverage) + "x | " + str.tostring(i_maxBars) + "b",

// Change to:
table.cell(tbl, 1, 8, str.tostring(i_riskPct, "#.#") + "% | " + str.tostring(i_leverage) + "x | " + str.tostring(i_maxBars) + "b | ESL" + str.tostring(i_emergSL) + "%",
```

---

## Execution Order Summary

After all changes, the Pine execution order per bar should be:

```
1. slTriggered check    → strategy.close() at open       (pending SL from prev bar)
2. strategy.exit(stop=) → emergency SL fires intra-bar   (L-ESL / S-ESL)
3. strategy.exit(limit=)→ TP1/TP2/TP3 fire intra-bar     (L-TP1..3 / S-TP1..3)
4. longExit/shortExit   → strategy.close() at close      (structural exits)
5. bar_index - longBar  → strategy.close() at close      (time exit)
6. close vs sl check    → sets slTriggered for next bar   (close-based SL)
7. goLong/goShort       → strategy.entry() at next open   (new entries)
```

This matches `engine/strategy.js` exit priority:
Emergency SL → TPs → Time → Structural → Close-based SL → Entry signals.

---

## Input ID Reference (CDP Mapping)

| Pine variable | Input ID | Gene / Source | Added/Changed |
|---|---|---|---|
| `i_startDate` | `in_0` | run `start_date` (timestamp) | |
| `i_endDate` | `in_1` | run `config.endDate` (timestamp) | **NEW** |
| `i_minEntry` | `in_2` | minEntry | **shifted +1** |
| `i_stochLen` | `in_3` | stochLen | **shifted +1** |
| `i_stochSmth` | `in_4` | stochSmth | **shifted +1** |
| `i_rsiLen` | `in_5` | rsiLen | **shifted +1** |
| `i_emaFast` | `in_6` | emaFast | **shifted +1** |
| `i_emaSlow` | `in_7` | emaSlow | **shifted +1** |
| `i_bbLen` | `in_8` | bbLen | **shifted +1** |
| `i_bbMult` | `in_9` | bbMult | **shifted +1** |
| `i_atrLen` | `in_10` | atrLen | **shifted +1** |
| `i_atrSL` | `in_11` | atrSL | **shifted +1** |
| `i_tp1Mult` | `in_12` | tp1Mult | **shifted +1** |
| `i_tp2Mult` | `in_13` | tp2Mult | **shifted +1** |
| `i_tp3Mult` | `in_14` | tp3Mult | **shifted +1** |
| `i_tp1Pct` | `in_15` | tp1Pct | **shifted +1** |
| `i_tp2Pct` | `in_16` | tp2Pct | **shifted +1** |
| `i_riskPct` | `in_17` | riskPct | **shifted +1** |
| `i_maxBars` | `in_18` | maxBars | **shifted +1** |
| `i_leverage` | `in_19` | *(forced to 1)* | **shifted +1** |
| `i_emergSL` | `in_20` | emergencySlPct | **shifted +1** |

---

## Testing Checklist

1. **Compile**: Load the script, confirm no errors.
2. **Emergency SL**: Find a bar with a huge wick (e.g., BTC 2025-10-10). Confirm
   the emergency SL fires intra-bar at the percentage level.
3. **Close-based SL**: Find a bar that wicks below SL but closes above it →
   trade stays open. Find a bar that closes below SL → exit at next bar's open.
4. **TP-only exits**: Confirm TPs still fire independently without a stop
   attached to them.
5. **CDP cross-validation**: `node scripts/tv-crossvalidate.js` — deltas under
   5% indicate good parity.
