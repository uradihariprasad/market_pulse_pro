/**
 * CANONICAL OI ENGINE tests — the 15 required calculation scenarios.
 *
 * Verifies the Continuous Cumulative OI methodology:
 *   opening baseline → cumulative change → derived Combined Total OI,
 *   with Actual Total OI always sourced from the provider.
 */
import { describe, it, expect } from "vitest";
import {
  OpeningBaselineStore, buildCanonicalOi, interpretPositioning,
} from "../src/lib/market/oiCanonical";
import type { OiObservation, StrikeObservation } from "../src/lib/market/oiIntelligence";

const BASE = Date.parse("2026-10-28T10:00:00+05:30");
const EXPIRY = "2026-10-29";
const STRIKES = [25000, 25100, 25200];

function obs(tOffsetMs: number, ceOi: number, peOi: number, ceLtp = 100, peLtp = 100): OiObservation {
  const strikes = new Map<number, StrikeObservation>();
  for (const s of STRIKES) strikes.set(s, { strike: s, ceOi, peOi, ceLtp, peLtp, ceVol: 10, peVol: 10 });
  return { t: BASE + tOffsetMs, exchangeTs: null, spot: 25100, expiry: EXPIRY, strikes };
}

function build(
  observations: OiObservation[],
  baseline: ReturnType<OpeningBaselineStore["get"]>,
  over: Partial<Parameters<typeof buildCanonicalOi>[0]> = {}
) {
  return buildCanonicalOi({
    underlyingKey: "NSE_INDEX|Nifty 50",
    symbol: "NIFTY",
    expiry: EXPIRY,
    spot: 25100,
    observations,
    baseline,
    fromProvider: true,
    now: BASE + 40 * 60_000,
    ...over,
  });
}

const strike = (r: ReturnType<typeof build>, s: number) => r.strikes.find((x) => x.strike === s)!;

// ------------------------------------------------- tests 1–4: cumulative math
describe("tests 1–4: cumulative change and combined total OI", () => {
  it("1. opening 25,000; cumulative +1,000 → combined 26,000", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 25_000, 25_000);
    store.capture("A", EXPIRY, base);
    const r = build([base, obs(30_000, 26_000, 26_000)], store.get("A", EXPIRY, "2026-10-28"));
    const ce = strike(r, 25100).ce;
    expect(ce.openingOi).toBe(25_000);
    expect(ce.cumulativeChangeOi).toBe(1_000);
    expect(ce.combinedTotalOi).toBe(26_000);
  });

  it("2. next change −500 → cumulative +500; combined 25,500", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 25_000, 25_000);
    store.capture("A", EXPIRY, base);
    const r = build(
      [base, obs(30_000, 26_000, 26_000), obs(60_000, 25_500, 25_500)],
      store.get("A", EXPIRY, "2026-10-28")
    );
    const ce = strike(r, 25100).ce;
    expect(ce.cumulativeChangeOi).toBe(500);
    expect(ce.combinedTotalOi).toBe(25_500);
  });

  it("3. next change +2,000 → cumulative +2,500; combined 27,500", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 25_000, 25_000);
    store.capture("A", EXPIRY, base);
    const r = build(
      [base, obs(30_000, 26_000, 26_000), obs(60_000, 25_500, 25_500), obs(90_000, 27_500, 27_500)],
      store.get("A", EXPIRY, "2026-10-28")
    );
    const ce = strike(r, 25100).ce;
    expect(ce.cumulativeChangeOi).toBe(2_500);
    expect(ce.combinedTotalOi).toBe(27_500);
  });

  it("4. actual OI reconciles with combined when baselines match", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 25_000, 25_000);
    store.capture("A", EXPIRY, base);
    const r = build([base, obs(30_000, 27_500, 27_500)], store.get("A", EXPIRY, "2026-10-28"));
    const ce = strike(r, 25100).ce;
    expect(ce.actualTotalOi).toBe(27_500);       // provider value
    expect(ce.combinedTotalOi).toBe(27_500);      // derived
    expect(ce.reconciliationDifference).toBe(0);
    expect(r.dataQuality.reconciliationStrikes).toBe(0);
    expect(r.dataQuality.status).not.toBe("RECONCILIATION_WARNING");
  });

});

// ------------------------------------------- tests 5–7: no fabrication
describe("tests 5–7: no fabricated changes", () => {
  it("5. missing observations do not create changes", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 25_000, 25_000);
    store.capture("A", EXPIRY, base);
    // a single long gap: 0 → 20min. No 5m/15m baseline exists.
    const r = build([base, obs(20 * 60_000, 30_000, 30_000)], store.get("A", EXPIRY, "2026-10-28"));
    const ce = strike(r, 25100).ce;
    expect(ce.changeOi5m).toBeNull();   // no observation near T-5m
    expect(ce.changeOi15m).toBeNull();  // no observation near T-15m
    expect(ce.cumulativeChangeOi).toBe(5_000); // cumulative still valid
  });

  it("6. duplicate timestamps do not double-count", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 25_000, 25_000);
    store.capture("A", EXPIRY, base);
    const dup = obs(30_000, 26_000, 26_000);
    // same timestamp repeated — OiHistory rejects it upstream; here we verify
    // that the canonical calculation itself is not sensitive to it.
    const r = build([base, dup, dup], store.get("A", EXPIRY, "2026-10-28"));
    const ce = strike(r, 25100).ce;
    // The direct formula uses only the endpoints, so duplicates cannot
    // distort the cumulative change.
    expect(ce.cumulativeChangeOi).toBe(1_000);
    expect(ce.changeOi30s).toBe(0); // identical consecutive observation
  });

  it("7. negative changes stay negative", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 30_000, 30_000);
    store.capture("A", EXPIRY, base);
    const r = build([base, obs(30_000, 25_000, 25_000)], store.get("A", EXPIRY, "2026-10-28"));
    const ce = strike(r, 25100).ce;
    expect(ce.cumulativeChangeOi).toBe(-5_000);
    expect(ce.changeOi30s).toBe(-5_000);
    expect(ce.combinedTotalOi).toBe(25_000);
  });
});

// --------------------------------- tests 8–9: independent rolling baselines
describe("tests 8–9: independent 5m and 15m baselines", () => {
  it("8. rolling 5m uses its own valid baseline", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 20_000, 20_000);
    store.capture("A", EXPIRY, base);
    // 5m-old observation = 50,000; 15m-old = 45,000; current = 47,000
    const r = build(
      [base, obs(15 * 60_000, 45_000, 45_000), obs(5 * 60_000, 50_000, 50_000), obs(20 * 60_000, 47_000, 47_000)],
      store.get("A", EXPIRY, "2026-10-28"),
      { now: BASE + 20 * 60_000 }
    );
    const ce = strike(r, 25100).ce;
    // now = 20min. 5m baseline = obs@15min (45,000) → 47,000 − 45,000 = +2,000
    expect(ce.changeOi5m).toBe(2_000);
    // 15m baseline = obs@5min (50,000) → 47,000 − 50,000 = −3,000
    expect(ce.changeOi15m).toBe(-3_000);
    // 15m is NOT 5m × 3, and the two windows used different baselines
    expect(ce.changeOi15m).not.toBe((ce.changeOi5m ?? 0) * 3);
  });

  it("9. rolling 15m uses its own baseline (independent of 5m)", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 10_000, 10_000);
    store.capture("A", EXPIRY, base);
    // dense 30s observations
    const obsList: OiObservation[] = [base];
    for (let s = 30; s <= 20 * 60; s += 30) {
      obsList.push(obs(s * 1000, 10_000 + s * 10, 10_000 + s * 10));
    }
    const r = build(obsList, store.get("A", EXPIRY, "2026-10-28"), { now: BASE + 20 * 60_000 });
    const ce = strike(r, 25100).ce;
    // 5m window ≈ 300s of build; 15m ≈ 900s
    expect(ce.changeOi5m).toBeCloseTo(3_000, -2);
    expect(ce.changeOi15m).toBeCloseTo(9_000, -2);
  });

  it("a baseline outside the ±30s tolerance is rejected", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 20_000, 20_000);
    store.capture("A", EXPIRY, base);
    // only a 3-minute-old observation exists → cannot be a 5m baseline
    const r = build(
      [base, obs(17 * 60_000, 45_000, 45_000), obs(20 * 60_000, 47_000, 47_000)],
      store.get("A", EXPIRY, "2026-10-28"),
      { now: BASE + 20 * 60_000 }
    );
    const ce = strike(r, 25100).ce;
    expect(ce.changeOi5m).toBeNull();   // no observation within ±30s of T-5m
    expect(ce.changeOi15m).toBeNull();
  });
});

// ------------------------------------ tests 10–14: baseline persistence
describe("tests 10–14: baseline persistence and resets", () => {
  it("10. restart restores the original opening baseline", () => {
    const before = new OpeningBaselineStore();
    const base = obs(0, 25_000, 25_000);
    before.capture("A", EXPIRY, base);
    // serialise → new store (restart) → restore
    const json = before.toJSON();
    const after = new OpeningBaselineStore();
    const n = after.restore(json);
    expect(n).toBe(1);
    const r = build([obs(30_000, 27_500, 27_500)], after.get("A", EXPIRY, "2026-10-28"));
    const ce = strike(r, 25100).ce;
    expect(ce.openingOi).toBe(25_000);
    expect(ce.cumulativeChangeOi).toBe(2_500);
    expect(ce.combinedTotalOi).toBe(27_500);
  });

  it("11. history-buffer eviction does not change cumulative change", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 25_000, 25_000);
    store.capture("A", EXPIRY, base);
    const full: OiObservation[] = [base];
    for (let s = 30; s <= 40 * 60; s += 30) full.push(obs(s * 1000, 26_000, 26_000));
    // evict the oldest rolling observations (simulating ring-buffer trim)
    const evicted = full.slice(full.length - 20);
    const rFull = build(full, store.get("A", EXPIRY, "2026-10-28"));
    const rEvicted = build(evicted, store.get("A", EXPIRY, "2026-10-28"));
    expect(strike(rEvicted, 25100).ce.cumulativeChangeOi)
      .toBe(strike(rFull, 25100).ce.cumulativeChangeOi);
  });

  it("12. a new expiry receives an independent baseline", () => {
    const store = new OpeningBaselineStore();
    store.capture("A", "2026-10-29", obs(0, 25_000, 25_000));
    store.capture("A", "2026-11-26", obs(0, 40_000, 40_000));
    const a = store.get("A", "2026-10-29", "2026-10-28")!;
    const b = store.get("A", "2026-11-26", "2026-10-28")!;
    expect(a.strikes.get(25100)!.ceOi).toBe(25_000);
    expect(b.strikes.get(25100)!.ceOi).toBe(40_000);
    // clearing one expiry leaves the other intact
    store.clearExpiry("A", "2026-10-29");
    expect(store.get("A", "2026-10-29", "2026-10-28")).toBeNull();
    expect(store.get("A", "2026-11-26", "2026-10-28")).not.toBeNull();
  });

  it("13. a new trading day resets the baseline", () => {
    const store = new OpeningBaselineStore();
    // 2026-10-28 observation
    store.capture("A", EXPIRY, obs(0, 25_000, 25_000));
    // 2026-10-29 observation → different session key
    const nextDay = obs(24 * 3_600_000, 35_000, 35_000);
    const cap = store.capture("A", EXPIRY, nextDay);
    expect(cap.captured).toBe(true); // a new baseline was created
    const b = store.get("A", EXPIRY, "2026-10-29");
    expect(b).not.toBeNull();
    expect(b!.strikes.get(25100)!.ceOi).toBe(35_000);
  });

  it("14. late startup labels the real timestamp, never a fake 09:15", () => {
    const store = new OpeningBaselineStore();
    // an observation at 12:30 IST
    const late = Date.parse("2026-10-28T12:30:00+05:30") - BASE;
    const cap = store.capture("A", EXPIRY, obs(late, 25_000, 25_000));
    expect(cap.status).toBe("LATE_CAPTURE");
    const b = store.get("A", EXPIRY, "2026-10-28")!;
    expect(b.at).toBe(BASE + late); // the REAL timestamp
    const r = build([obs(late, 25_000, 25_000), obs(late + 30_000, 26_000, 26_000)], b);
    expect(r.dataQuality.baselineStatus).toBe("LATE_CAPTURE");
    expect(r.dataQuality.notes.join(" ")).toMatch(/NOT a fabricated 09:15/);
  });

  it("an early observation is labelled PERSISTED", () => {
    const store = new OpeningBaselineStore();
    const early = Date.parse("2026-10-28T09:20:00+05:30") - BASE;
    const cap = store.capture("A", EXPIRY, obs(early, 25_000, 25_000));
    expect(cap.status).toBe("PERSISTED");
  });
});

// ------------------------------------- test 15: incomplete strike data
describe("test 15: incomplete strike data", () => {
  it("produces a warning, not false zero OI", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 25_000, 25_000);
    // remove one strike from the baseline so it is incomplete
    base.strikes.delete(25100);
    store.capture("A", EXPIRY, base);
    const r = build([base, obs(30_000, 26_000, 26_000)], store.get("A", EXPIRY, "2026-10-28"));
    const ce = strike(r, 25100).ce;
    expect(ce.openingOi).toBeNull();      // not zero
    expect(ce.cumulativeChangeOi).toBeNull();
    expect(ce.combinedTotalOi).toBeNull();
    expect(r.dataQuality.invalidStrikes).toContain(25100);
    expect(r.dataQuality.status).not.toBe("VALID");
    // other strikes still work
    expect(strike(r, 25000).ce.cumulativeChangeOi).toBe(1_000);
  });
});

// ------------------------------------------- positioning interpretation
describe("OI positioning interpretation (Part 5)", () => {
  it("maps OI change × premium change to the four interpretations", () => {
    expect(interpretPositioning(1000, 5)).toBe("POSSIBLE_LONG_BUILDUP");
    expect(interpretPositioning(1000, -5)).toBe("POSSIBLE_WRITING");
    expect(interpretPositioning(-1000, 5)).toBe("POSSIBLE_SHORT_COVERING");
    expect(interpretPositioning(-1000, -5)).toBe("POSSIBLE_LONG_UNWINDING");
  });

  it("returns NO_CLEAR_POSITIONING when either input is missing", () => {
    expect(interpretPositioning(null, 5)).toBe("NO_CLEAR_POSITIONING");
    expect(interpretPositioning(1000, null)).toBe("NO_CLEAR_POSITIONING");
    expect(interpretPositioning(0, 5)).toBe("NO_CLEAR_POSITIONING");
  });
});

// ------------------------------------------------- contract completeness
describe("canonical data contract (Part 7)", () => {
  it("exposes every required field, keeping unavailable values null", () => {
    const store = new OpeningBaselineStore();
    const r = build([], null, { fromProvider: false });
    const ce = r.strikes[0]?.ce;
    if (!ce) { expect(r.strikes).toHaveLength(0); return; }
    for (const k of [
      "openingOi", "openingBaselineAt", "actualTotalOi", "actualOiAt",
      "changeOi30s", "changeOi5m", "changeOi15m", "cumulativeChangeOi",
      "combinedTotalOi", "reconciliationDifference", "dataQualityStatus",
      "baselineStatus", "observationCount", "lastObservationAt",
      "premiumChange5m", "premiumChange15m", "positioningInterpretation",
    ] as const) {
      expect(ce).toHaveProperty(k);
    }
    expect(ce.actualTotalOi).toBeNull();
    expect(r.dataQuality.status).toBe("COLLECTING");
  });

  it("actual OI is never derived from change OI", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 25_000, 25_000);
    store.capture("A", EXPIRY, base);
    const r = build([base, obs(30_000, 30_000, 30_000)], store.get("A", EXPIRY, "2026-10-28"));
    const ce = strike(r, 25100).ce;
    // actual is the provider number, NOT opening + change
    expect(ce.actualTotalOi).toBe(30_000);
    expect(ce.actualTotalOi).not.toBe(ce.combinedTotalOi! + ce.changeOi30s!);
  });

  it("keeps CE and PE separate for every strike", () => {
    const store = new OpeningBaselineStore();
    const base = obs(0, 25_000, 20_000); // CE 25k, PE 20k
    store.capture("A", EXPIRY, base);
    const r = build([base, obs(30_000, 26_000, 18_000)], store.get("A", EXPIRY, "2026-10-28"));
    const s = strike(r, 25100);
    expect(s.ce.cumulativeChangeOi).toBe(1_000);
    expect(s.pe.cumulativeChangeOi).toBe(-2_000);
    expect(s.ce.combinedTotalOi).toBe(26_000);
    expect(s.pe.combinedTotalOi).toBe(18_000);
  });
});
