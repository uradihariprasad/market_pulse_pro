import { describe, expect, it } from "vitest";
import { BuyerSellerIntelligence } from "../src/lib/market/buyerSellerIntelligence";
import type { Quote } from "../src/lib/market/types";

function quote(over: Partial<Quote> = {}): Quote {
  return {
    instrumentKey: "NSE_EQ|TEST", source: "UPSTOX_REST_POLL", exchangeTs: null,
    lastTradeTs: null, localTs: 1_800_000_000_000, ltp: 100, ltq: 10,
    volumeCum: 1000, oi: null, open: 99, high: 101, low: 98, close: 99,
    netChange: 1, atp: 100, bid: { p: 99.95, q: 10000 }, ask: { p: 100.05, q: 2000 },
    bids: [{ p: 99.95, q: 10000 }, { p: 99.9, q: 1000 }, { p: 99.85, q: 100 }],
    asks: [{ p: 100.05, q: 2000 }, { p: 100.1, q: 150 }, { p: 100.15, q: 100 }],
    depthLevels: 5, quality: "LIVE", ...over,
  };
}

describe("BuyerSellerIntelligence", () => {
  it("reports displayed bid/ask imbalance without calling it executed flow", () => {
    const tracker = new BuyerSellerIntelligence();
    const result = tracker.ingest(quote());
    expect(result.imbalancePct).toBeGreaterThan(0);
    expect(result.dominantSide).toBe("BUYER");
    expect(result.mode).toBe("PASSIVE_LIQUIDITY_ONLY");
    expect(result.note).toMatch(/not executed buyer\/seller volume/i);
  });

  it("tracks persistent large bid liquidity across distinct snapshots", () => {
    const tracker = new BuyerSellerIntelligence();
    const first = tracker.ingest(quote());
    const second = tracker.ingest(quote({ localTs: 1_800_000_001_000 }));
    const bid = second.levels.find((x) => x.side === "BUYER");
    expect(first.levels.length).toBeGreaterThan(0);
    expect(bid).toBeDefined();
    expect(bid!.persistence).toBe(2);
  });

  it("distinguishes liquidity replenishment after a reduction", () => {
    const tracker = new BuyerSellerIntelligence();
    tracker.ingest(quote());
    tracker.ingest(quote({
      localTs: 1_800_000_001_000,
      bids: [{ p: 99.95, q: 5000 }, { p: 99.9, q: 1000 }, { p: 99.85, q: 100 }],
      bid: { p: 99.95, q: 5000 },
    }));
    const replenished = tracker.ingest(quote({
      localTs: 1_800_000_002_000,
      bids: [{ p: 99.95, q: 9000 }, { p: 99.9, q: 1000 }, { p: 99.85, q: 100 }],
      bid: { p: 99.95, q: 9000 },
    }));
    expect(replenished.events.some((x) => x.type === "REPLENISHED" && x.side === "BUYER")).toBe(true);
  });

  it("does not invent liquidity when depth is absent", () => {
    const tracker = new BuyerSellerIntelligence();
    const result = tracker.ingest(quote({ bids: [], asks: [], bid: null, ask: null, depthLevels: 0 }));
    expect(result.quality).toBe("UNAVAILABLE");
    expect(result.levels).toHaveLength(0);
    expect(result.imbalancePct).toBeNull();
  });
});
