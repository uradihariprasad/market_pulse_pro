# Market Pulse — Dynamic S/R and Buyer/Seller Upgrade

## What changed

- Added `src/lib/market/upstoxStream.ts`: server-side Upstox Market Data Feed V3 adapter, minimal protobuf decoder for the documented V3 feed fields, subscription diffing, reconnect handling, and JSON-message compatibility.
- Added `src/lib/market/buyerSellerIntelligence.ts`: passive bid/ask depth imbalance, relative large-wall detection, persistence tracking, and liquidity appearance/increase/reduction/disappearance events.
- Extended `engine.ts` to stream core indices, focused instrument, its mapped futures, and ATM ±3 option contracts when chain instrument keys are available. Broad F&O coverage continues through the existing REST scheduler.
- Added `/api/market-stream` SSE endpoint. The selected chart receives buyer/seller depth and Unified S/R updates every 500 ms without re-fetching candle history each time.
- Added buyer/seller liquidity bands and price labels to `PriceChart.tsx`, plus a liquidity intelligence panel in SRMap.
- Unified S/R now receives local liquidity evidence and estimated CVD context. OI build alone is not treated as proof of writing; premium posture is used to resolve possible writing vs buying.
- Corrected structural/OI provenance filtering at the Unified S/R integration boundary, independent interaction counting, acceptance traversal tracking, OI peak normalization, candidate retention near spot, and the distinction between a genuine reclaim and a failed retest/ROLE_REVERSED level.
- For index/equity instruments without usable direct depth, mapped futures depth can be used as a clearly labelled proxy. Its price levels are rebased to spot using fresh simultaneous quotes; if the basis is stale, proxy levels are suppressed.

## Data honesty and limitations

- Bid/ask quantities are passive displayed liquidity, not executed volume.
- A disappearing depth level is labelled `DISAPPEARED`; the system does not claim it was cancelled or filled.
- Streamed cumulative-volume increments are used by the existing FlowTracker with quote-rule/tick-rule estimation. Upstox does not provide a guaranteed aggressor-side flag or complete trade tape here, so exact exchange aggressor delta remains unavailable.
- OI history continues to use the existing timestamped option-chain observations. Streamed option OI is not merged into the complete strike ladder because only a focused ATM ±3 subset is streamed; mixing partial strike timestamps into the complete ladder would create misleading rolling windows.
- The chart heatmap is a live snapshot overlay of currently displayed large depth levels, with translucent dynamic S/R zone bands; it is not historical order-book replay.
- The stream subscription is bounded to the core indices, focused instrument, mapped future(s), and ATM ±3 CE/PE. The full F&O universe remains REST-covered.

## Dependencies and deployment

- Added `upstox-js-sdk` (`^2.32.0`) and marked it as a Next.js server external package.
- Install dependencies in the project environment with `npm install` before building/deploying.
- Keep the Upstox token server-side. No token is sent to the browser.
- Optional `UPSTOX_STREAM_MODE=full_d30` requests 30-level depth where the account entitlement supports it; default is `full` (D5).
- Verify Upstox account/API entitlements and subscription limits before relying on live stream delivery.

## Validation performed in this workspace

- TypeScript transpile/syntax check passed for all changed TypeScript/TSX files.
- Manually exercised the V3 protobuf decoder against constructed LTPC and full-depth FeedResponse messages, checked buyer/seller imbalance/persistence, and exercised ROLE_REVERSED and RECLAIMED S/R lifecycle scenarios.
- Full `tsc`, Vitest and Next build could not be completed here because project dependencies were not installed; `npm install` timed out in this environment. Run `npm install`, `npm run typecheck`, `npx vitest run`, and `npm run build` in the deployment/dev environment before live use.
