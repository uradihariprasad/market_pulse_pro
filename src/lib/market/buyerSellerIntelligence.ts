import type { Quote } from "./types";

export type LiquiditySide = "BUYER" | "SELLER";
export type LiquidityEventType = "APPEARED" | "INCREASED" | "REDUCED" | "REPLENISHED" | "DISAPPEARED";

export interface LiquidityLevel {
  id: string;
  side: LiquiditySide;
  price: number;
  quantity: number;
  relativeSize: number;
  persistence: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface LiquidityEvent {
  type: LiquidityEventType;
  side: LiquiditySide;
  price: number;
  previousQuantity: number;
  currentQuantity: number;
  at: number;
}

export interface BuyerSellerSnapshot {
  instrumentKey: string;
  sourceInstrumentKey?: string;
  isProxy?: boolean;
  source: "UPSTOX_REST_DEPTH";
  mode: "PASSIVE_LIQUIDITY_ONLY";
  quality: "LIVE" | "STALE" | "PARTIAL" | "UNAVAILABLE";
  updatedAt: number;
  ageMs: number;
  depthLevels: number;
  totalBidQuantity: number;
  totalAskQuantity: number;
  imbalancePct: number | null;
  buyerLiquidityScore: number | null;
  sellerLiquidityScore: number | null;
  dominantSide: "BUYER" | "SELLER" | "BALANCED" | "UNKNOWN";
  levels: LiquidityLevel[];
  events: LiquidityEvent[];
  note: string;
}

interface TrackedLevel extends LiquidityLevel { missingCount: number; lastReducedAt: number }
interface InstrumentState {
  lastSnapshotAt: number;
  previous: Map<string, number>;
  tracked: Map<string, TrackedLevel>;
  latest: BuyerSellerSnapshot | null;
}

const MAX_TRACKED = 120;
const PRICE_EPSILON = 0.0001;
const STALE_MS = 25_000;

function validLevels(levels: { p: number; q: number }[] | undefined) {
  return (levels ?? []).filter((x) => Number.isFinite(x.p) && x.p > 0 && Number.isFinite(x.q) && x.q > 0);
}
function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function levelKey(side: LiquiditySide, price: number): string { return `${side}|${price.toFixed(4)}`; }

/**
 * Tracks passive displayed liquidity from provider depth snapshots.
 * It deliberately does NOT call resting orders executed trades, nor infer
 * cancellation vs execution from a disappearing level. Aggressor flow remains
 * the separate ESTIMATED FlowTracker output.
 */
export class BuyerSellerIntelligence {
  private states = new Map<string, InstrumentState>();

  ingest(quote: Quote): BuyerSellerSnapshot {
    let state = this.states.get(quote.instrumentKey);
    if (!state) {
      state = { lastSnapshotAt: 0, previous: new Map(), tracked: new Map(), latest: null };
      this.states.set(quote.instrumentKey, state);
    }
    const now = quote.localTs;
    const bids = validLevels(quote.bids?.length ? quote.bids : quote.bid ? [quote.bid] : []).sort((a, b) => b.p - a.p).slice(0, 30);
    const asks = validLevels(quote.asks?.length ? quote.asks : quote.ask ? [quote.ask] : []).sort((a, b) => a.p - b.p).slice(0, 30);
    if (!bids.length && !asks.length) {
      const unavailable: BuyerSellerSnapshot = {
        instrumentKey: quote.instrumentKey, source: "UPSTOX_REST_DEPTH", mode: "PASSIVE_LIQUIDITY_ONLY",
        quality: "UNAVAILABLE", updatedAt: now, ageMs: 0, depthLevels: 0,
        totalBidQuantity: 0, totalAskQuantity: 0, imbalancePct: null,
        buyerLiquidityScore: null, sellerLiquidityScore: null, dominantSide: "UNKNOWN",
        levels: [], events: [], note: "No usable bid/ask depth in the latest provider snapshot.",
      };
      state.latest = unavailable;
      return unavailable;
    }

    const bidTotal = bids.reduce((a, x) => a + x.q, 0);
    const askTotal = asks.reduce((a, x) => a + x.q, 0);
    const denom = bidTotal + askTotal;
    const imbalancePct = denom > 0 ? ((bidTotal - askTotal) / denom) * 100 : null;
    const bidMedian = median(bids.map((x) => x.q));
    const askMedian = median(asks.map((x) => x.q));
    const bidThreshold = Math.max(bidMedian * 2.5, bidTotal / Math.max(bids.length, 1) * 1.8);
    const askThreshold = Math.max(askMedian * 2.5, askTotal / Math.max(asks.length, 1) * 1.8);
    const candidates = [
      ...bids.filter((x) => x.q >= bidThreshold).map((x) => ({ ...x, side: "BUYER" as const })),
      ...asks.filter((x) => x.q >= askThreshold).map((x) => ({ ...x, side: "SELLER" as const })),
    ];
    const current = new Map<string, number>();
    const events: LiquidityEvent[] = [];
    const levels: LiquidityLevel[] = [];

    for (const c of candidates) {
      const key = levelKey(c.side, c.p);
      current.set(key, c.q);
      const old = state.tracked.get(key);
      const persistence = old ? old.persistence + (now > old.lastSeenAt ? 1 : 0) : 1;
      const firstSeenAt = old?.firstSeenAt ?? now;
      const level: TrackedLevel = {
        id: `${quote.instrumentKey}|${key}`, side: c.side, price: c.p, quantity: c.q,
        relativeSize: c.q / Math.max(c.side === "BUYER" ? bidMedian : askMedian, 1),
        persistence, firstSeenAt, lastSeenAt: now, missingCount: 0, lastReducedAt: old?.lastReducedAt ?? 0,
      };
      if (!old) events.push({ type: "APPEARED", side: c.side, price: c.p, previousQuantity: 0, currentQuantity: c.q, at: now });
      else if (c.q > old.quantity * 1.15) {
        const replenished = old.lastReducedAt > 0;
        events.push({ type: replenished ? "REPLENISHED" : "INCREASED", side: c.side, price: c.p, previousQuantity: old.quantity, currentQuantity: c.q, at: now });
        level.lastReducedAt = 0;
      } else if (c.q < old.quantity * 0.75) {
        events.push({ type: "REDUCED", side: c.side, price: c.p, previousQuantity: old.quantity, currentQuantity: c.q, at: now });
        level.lastReducedAt = now;
      }
      state.tracked.set(key, level);
      levels.push(level);
    }

    for (const [key, old] of state.tracked) {
      if (current.has(key)) continue;
      old.missingCount++;
      if (old.missingCount === 1) events.push({ type: "DISAPPEARED", side: old.side, price: old.price, previousQuantity: old.quantity, currentQuantity: 0, at: now });
      if (old.missingCount >= 3 || now - old.lastSeenAt > 60_000) state.tracked.delete(key);
    }
    // A snapshot with no new event must not inflate persistence; only update
    // tracked levels when a newer provider observation has arrived.
    state.lastSnapshotAt = Math.max(state.lastSnapshotAt, now);
    state.previous = current;
    const maxBid = Math.max(0, ...levels.filter((x) => x.side === "BUYER").map((x) => x.quantity));
    const maxAsk = Math.max(0, ...levels.filter((x) => x.side === "SELLER").map((x) => x.quantity));
    const buyerScore = denom > 0 ? Math.max(0, Math.min(100, 50 + (imbalancePct ?? 0) * 0.5)) : null;
    const sellerScore = buyerScore === null ? null : 100 - buyerScore;
    const dominantSide = imbalancePct === null ? "UNKNOWN" : imbalancePct > 12 ? "BUYER" : imbalancePct < -12 ? "SELLER" : "BALANCED";
    const snapshot: BuyerSellerSnapshot = {
      instrumentKey: quote.instrumentKey, source: "UPSTOX_REST_DEPTH", mode: "PASSIVE_LIQUIDITY_ONLY",
      quality: quote.quality === "LIVE" && now - quote.localTs <= STALE_MS ? "LIVE" : quote.quality === "PARTIAL" ? "PARTIAL" : "STALE",
      updatedAt: now, ageMs: Math.max(0, Date.now() - now), depthLevels: quote.depthLevels,
      totalBidQuantity: bidTotal, totalAskQuantity: askTotal, imbalancePct,
      buyerLiquidityScore: buyerScore, sellerLiquidityScore: sellerScore, dominantSide,
      levels: levels.sort((a, b) => b.quantity - a.quantity).slice(0, 12),
      events: events.slice(-20),
      note: `Displayed passive depth only (${quote.depthLevels} level(s)); not executed buyer/seller volume. Disappearing liquidity is not classified as cancelled or filled.`,
    };
    state.latest = snapshot;
    // Bound memory across a large F&O universe.
    if (this.states.size > 350) {
      const oldest = [...this.states.entries()].sort((a, b) => a[1].lastSnapshotAt - b[1].lastSnapshotAt)[0];
      if (oldest && oldest[0] !== quote.instrumentKey) this.states.delete(oldest[0]);
    }
    return snapshot;
  }

  get(instrumentKey: string, now = Date.now()): BuyerSellerSnapshot | null {
    const snapshot = this.states.get(instrumentKey)?.latest ?? null;
    if (!snapshot) return null;
    const ageMs = Math.max(0, now - snapshot.updatedAt);
    return { ...snapshot, ageMs, quality: ageMs > STALE_MS ? "STALE" : snapshot.quality };
  }
}

export function liquidityNearLevel(
  snapshot: BuyerSellerSnapshot | null,
  side: "SUPPORT" | "RESISTANCE",
  price: number,
  tolerance: number
): LiquidityLevel[] {
  if (!snapshot || snapshot.quality !== "LIVE") return [];
  const wanted: LiquiditySide = side === "SUPPORT" ? "BUYER" : "SELLER";
  return snapshot.levels.filter((x) => x.side === wanted && Math.abs(x.price - price) <= tolerance + PRICE_EPSILON);
}
