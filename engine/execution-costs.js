/**
 * Execution-cost constants — shared by the runtime and by blocks that need
 * to apply slippage themselves (e.g., market-style intra-bar stops).
 *
 * These match TradingView's default strategy-tester assumptions so we stay
 * bit-identical with Pine backtests. Per-run overrides (different exchange,
 * different asset) will land in the run config later (see backlog).
 */

export const COMMISSION_PCT = 0.06 / 100; // 0.06% per side
export const SLIPPAGE_TICKS = 2;           // TradingView default
export const MINTICK        = 0.01;        // USD/USDT crypto default
export const SLIPPAGE       = SLIPPAGE_TICKS * MINTICK; // = 0.02
