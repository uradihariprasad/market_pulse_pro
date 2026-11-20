/**
 * CANONICAL OI INTELLIGENCE ENGINE — Continuous Cumulative OI methodology.
 *
 * This is the ONE source of truth for every OI metric in the application.
 * It computes five independent metrics per strike, separately for CE and PE:
 *
 *   1. changeOi30s            — latest vs the previous distinct observation
 *   2. changeOi5m             — rolling 5-minute, strict timestamp validation
 *   3. changeOi15m            — rolling 15-minute, independently validated
 *   4. cumulativeChangeOi     — net change from the persisted OPENING baseline
 *   5. combinedTotalOi        — opening baseline + cumulative change (DERIVED)
 *   6. actualTotalOi          — the provider's own OI (never derived)
 *
 * HONESTY RULES (enforced and tested):
 *  - The opening baseline is captured ONCE per (underlying, expiry, session)
 *    and PERSISTED independently of the rolling ring buffer. Buffer eviction
 *    and server restarts cannot change it.
 *  - The earliest retained observation is NEVER used as the opening baseline.
 *  - A late startup labels the baseline with its real timestamp; it never
 *    fabricates a 09:15 value.
 *  - Actual Total OI is only ever the provider's number. It is never computed
 *    by adding change OI, and change OI is never added to an updated current.
 *  - combinedTotalOi is explicitly DERIVED and reconciled against the actual
 *    value; a discrepancy produces RECONCILIATION_WARNING, never a silent
 *    overwrite.
 *  - Unavailable values stay null. Missing OI is never a genuine zero.
 */

import { round4, istDateKey } from "./types";
import type { OiObservation, StrikeObservation } from "./oiIntelligence";
import { BASELINE_TOLERANCE_MS } from "./oiIntelligence";

// ---------------------------------------------------------------- contract

export type OiDataQualityStatus =
  | "VALID"
  | "COLLECTING"
  | "INSUFFICIENT_HISTORY"
  | "STALE_DATA"
  | "INVALID_BASELINE"
  | "API_ERROR"
  | "RECONCILIATION_WARNING";

export type OiBaselineStatus =
  | "PERSISTED"      // captured at/near the session open
  | "LATE_CAPTURE"   // first genuine observation after the open (timestamped honestly)
  | "PENDING";       // not yet captured

export type OiPositioning =
  | "POSSIBLE_LONG_BUILDUP"
  | "POSSIBLE_WRITING"
  | "POSSIBLE_SHORT_COVERING"
  | "POSSIBLE_LONG_UNWINDING"
  | "NO_CLEAR_POSITIONING";

/** The canonical per-strike, per-side OI record. */
export interface CanonicalOiSide {
  /** OI captured at the session baseline. null until captured. */
  openingOi: number | null;
  openingBaselineAt: number | null;
  /** Provider-reported OI. Never derived. */
  actualTotalOi: number | null;
  actualOiAt: number | null;
  changeOi30s: number | null;
  changeOi5m: number | null;
  changeOi15m: number | null;
  cumulativeChangeOi: number | null;
  /** openingOi + cumulativeChangeOi (DERIVED, never exchange-reported). */
  combinedTotalOi: number | null;
  /** combinedTotalOi − actualTotalOi, when both exist. */
  reconciliationDifference: number | null;
  dataQualityStatus: OiDataQualityStatus;
  baselineStatus: OiBaselineStatus;
  observationCount: number;
  lastObservationAt: number | null;
  premiumChange5m: number | null;
  premiumChange15m: number | null;
  positioningInterpretation: OiPositioning;
}

export interface CanonicalOiStrike {
  strike: number;
  ce: CanonicalOiSide;
  pe: CanonicalOiSide;
}

export interface CanonicalOiResult {
  underlyingKey: string;
  symbol: string;
  expiry: string;
  spot: number | null;
  atmStrike: number | null;
  focusStrikes: number[];
  ladder: number[];
  /** True when the ladder came from a real provider chain response. */
  fromProvider: boolean;
  strikes: CanonicalOiStrike[];
  /** Cumulative change history for the continuous OI chart. */
  history: { t: number; ce: number | null; pe: number | null }[];
  dataQuality: {
    status: OiDataQualityStatus;
    baselineStatus: OiBaselineStatus;
    openingBaselineAt: number | null;
    observationCount: number;
    lastObservationAt: number | null;
    missingIntervals: number;
    staleData: boolean;
    /** Largest |combined − actual| across strikes, for the warning banner. */
    maxReconciliationDifference: number | null;
    reconciliationStrikes: number;
    invalidStrikes: number[];
    apiError: string | null;
    notes: string[];
  };
  capturedAt: number;
}

// ---------------------------------------------------- opening baseline store

/**
 * Persisted opening baselines, keyed by (underlyingKey, expiry, sessionDate).
 *
 * Stored SEPARATELY from the rolling ring buffer so that eviction and
 * restarts cannot alter it. A new trading day or a new expiry gets its own
 * baseline; nothing else resets it.
 */
export class OpeningBaselineStore {
  private baselines = new Map<
    string,
    { at: number; sessionDate: string; status: OiBaselineStatus; strikes: Map<number, StrikeObservation> }
  >();

  private static id(underlyingKey: string, expiry: string, sessionDate: string): string {
    return `${underlyingKey}|${expiry}|${sessionDate}`;
  }

  /**
   * Capture the opening baseline for a session. Only the FIRST genuine
   * observation of that session is used; later calls are ignored so the
   * baseline can never drift during the day.
   */
  capture(
    underlyingKey: string,
    expiry: string,
    obs: OiObservation
  ): { captured: boolean; status: OiBaselineStatus } {
    const sessionDate = istDateKey(obs.t);
    const id = OpeningBaselineStore.id(underlyingKey, expiry, sessionDate);
    if (this.baselines.has(id)) {
      return { captured: false, status: this.baselines.get(id)!.status };
    }
    // Is this observation near the session open? If not, it is still a valid
    // baseline but is honestly labelled LATE_CAPTURE with its real timestamp.
    const minutesOfDay = (() => {
      const d = new Date(obs.t + 5.5 * 3_600_000);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    })();
    const status: OiBaselineStatus = minutesOfDay <= 9 * 60 + 25 ? "PERSISTED" : "LATE_CAPTURE";
    this.baselines.set(id, {
      at: obs.t,
      sessionDate,
      status,
      strikes: new Map(obs.strikes),
    });
    return { captured: true, status };
  }

  get(underlyingKey: string, expiry: string, sessionDate: string) {
    return this.baselines.get(OpeningBaselineStore.id(underlyingKey, expiry, sessionDate)) ?? null;
  }

  /** For persistence: serialise every baseline. */
  toJSON(): { underlyingKey: string; expiry: string; sessionDate: string; at: number; status: OiBaselineStatus; strikes: [number, StrikeObservation][] }[] {
    const out: ReturnType<OpeningBaselineStore["toJSON"]> = [];
    for (const [id, b] of this.baselines) {
      const [underlyingKey, expiry, sessionDate] = id.split("|");
      out.push({
        underlyingKey, expiry, sessionDate, at: b.at, status: b.status,
        strikes: [...b.strikes.entries()],
      });
    }
    return out;
  }

  /** Restore persisted baselines (server restart). */
  restore(rows: ReturnType<OpeningBaselineStore["toJSON"]>): number {
    let n = 0;
    for (const r of rows) {
      if (!r.underlyingKey || !r.expiry || !r.sessionDate) continue;
      const id = OpeningBaselineStore.id(r.underlyingKey, r.expiry, r.sessionDate);
      if (this.baselines.has(id)) continue; // never overwrite an existing baseline
      this.baselines.set(id, {
        at: r.at, sessionDate: r.sessionDate, status: r.status,
        strikes: new Map(r.strikes),
      });
      n++;
    }
    return n;
  }

  /** Drop baselines for a rolled-over expiry. */
  clearExpiry(underlyingKey: string, expiry: string): void {
    for (const id of [...this.baselines.keys()]) {
      if (id.startsWith(`${underlyingKey}|${expiry}|`)) this.baselines.delete(id);
    }
  }

  size(): number {
    return this.baselines.size;
  }
}

// ------------------------------------------------------------- positioning

/**
 * OI positioning from OI change + premium change (Part 5).
 * Probabilistic interpretations only — never proof of participant identity.
 */
export function interpretPositioning(
  oiChange: number | null,
  premiumChange: number | null
): OiPositioning {
  if (oiChange === null || oiChange === 0) return "NO_CLEAR_POSITIONING";
  const oiUp = oiChange > 0;
  const premUp = premiumChange !== null && premiumChange > 0;
  const premDn = premiumChange !== null && premiumChange < 0;
  if (oiUp && premUp) return "POSSIBLE_LONG_BUILDUP";
  if (oiUp && premDn) return "POSSIBLE_WRITING";
  if (!oiUp && premUp) return "POSSIBLE_SHORT_COVERING";
  if (!oiUp && premDn) return "POSSIBLE_LONG_UNWINDING";
  return "NO_CLEAR_POSITIONING";
}

// ------------------------------------------------------------ calculation

interface SideAt {
  oi: number | null;
  ltp: number | null;
}

function sideOf(obs: OiObservation | null, strike: number, side: "ce" | "pe"): SideAt {
  if (!obs) return { oi: null, ltp: null };
  const s = obs.strikes.get(strike);
  if (!s) return { oi: null, ltp: null };
  return side === "ce" ? { oi: s.ceOi, ltp: s.ceLtp } : { oi: s.peOi, ltp: s.peLtp };
}

/**
 * Build the canonical OI record for one underlying + expiry.
 *
 * `observations` must be the rolling timestamped history (ascending). The
 * opening baseline comes from the PERSISTED store, never from `observations[0]`.
 */
export function buildCanonicalOi(args: {
  underlyingKey: string;
  symbol: string;
  expiry: string;
  spot: number | null;
  observations: OiObservation[];
  baseline: { at: number; status: OiBaselineStatus; strikes: Map<number, StrikeObservation> } | null;
  fromProvider: boolean;
  apiError?: string | null;
  now?: number;
}): CanonicalOiResult {
  const now = args.now ?? Date.now();
  const obs = args.observations;
  const latest = obs.length ? obs[obs.length - 1] : null;
  const prev = obs.length > 1 ? obs[obs.length - 2] : null;

  // Rolling baselines, strictly validated (independent of each other).
  const findBaseline = (windowMs: number): OiObservation | null => {
    if (obs.length < 2) return null;
    const target = (latest?.t ?? now) - windowMs;
    let best: OiObservation | null = null;
    let bestGap = Infinity;
    for (const o of obs) {
      const gap = Math.abs(o.t - target);
      if (gap > BASELINE_TOLERANCE_MS) continue; // reject too-new AND too-old
      if (gap < bestGap) { bestGap = gap; best = o; }
    }
    return best;
  };
  const b5 = findBaseline(5 * 60_000);
  const b15 = findBaseline(15 * 60_000);

  // Ladder: prefer the provider's real strikes from the latest observation,
  // falling back to the baseline's strikes so the ladder is never invented.
  const ladderSet = new Set<number>([...momentumKeys(latest), ...momentumKeys(args.baseline)]);
  const ladder = [...ladderSet].sort((a, b) => a - b);

  // ATM from the real ladder and spot.
  const atmStrike = args.spot !== null && ladder.length
    ? ladder.reduce((best, s) => (Math.abs(s - args.spot!) < Math.abs(best - args.spot!) ? s : best), ladder[0])
    : null;
  const atmIdx = atmStrike !== null ? ladder.indexOf(atmStrike) : -1;
  const focusStrikes = atmIdx >= 0 ? ladder.slice(Math.max(0, atmIdx - 3), Math.min(ladder.length, atmIdx + 4)) : [];

  // Missing-interval detection over the retained window (informational only;
  // no values are interpolated).
  let missingIntervals = 0;
  for (let i = 1; i < obs.length; i++) {
    const gap = obs[i].t - obs[i - 1].t;
    if (gap > 90_000) missingIntervals++;
  }

  const staleData = latest !== null && now - latest.t > 150_000;
  const invalidStrikes: number[] = [];
  let reconciliationStrikes = 0;
  let maxRecon: number | null = null;

  const strikes: CanonicalOiStrike[] = ladder.map((strike) => {
    const build = (side: "ce" | "pe"): CanonicalOiSide => {
      const cur = sideOf(latest, strike, side);
      const p30 = sideOf(prev, strike, side);
      const s5 = sideOf(b5, strike, side);
      const s15 = sideOf(b15, strike, side);
      const baselineObs: OiObservation | null = args.baseline
        ? { t: args.baseline.at, exchangeTs: null, spot: null, expiry: args.expiry, strikes: args.baseline.strikes }
        : null;
      const base = sideOf(baselineObs, strike, side);

      // ---- actual OI: provider only
      const actualTotalOi = cur.oi;
      const actualOiAt = actualTotalOi !== null ? (latest?.t ?? null) : null;

      // ---- 30s change: latest vs previous DISTINCT observation
      const changeOi30s = cur.oi !== null && p30.oi !== null ? round4(cur.oi - p30.oi) : null;

      // ---- rolling 5m / 15m, each from its own validated baseline
      const changeOi5m = cur.oi !== null && s5.oi !== null ? round4(cur.oi - s5.oi) : null;
      const changeOi15m = cur.oi !== null && s15.oi !== null ? round4(cur.oi - s15.oi) : null;

      // ---- cumulative from the PERSISTED opening baseline.
      // Spec formula: Cumulative Change OI = Current Actual OI − Opening Baseline OI.
      // Computed directly from the two endpoints so duplicate observations and
      // ring-buffer eviction can never distort it.
      const cumulativeChangeOi = cur.oi !== null && base.oi !== null ? round4(cur.oi - base.oi) : null;

      // ---- combined total: DERIVED
      const combinedTotalOi = base.oi !== null && cumulativeChangeOi !== null ? round4(base.oi + cumulativeChangeOi) : null;

      // ---- reconciliation (never a silent overwrite)
      const reconciliationDifference = combinedTotalOi !== null && actualTotalOi !== null
        ? round4(combinedTotalOi - actualTotalOi)
        : null;
      if (reconciliationDifference !== null && Math.abs(reconciliationDifference) > Math.max(1, (actualTotalOi ?? 0) * 0.01)) {
        reconciliationStrikes++;
        if (maxRecon === null || Math.abs(reconciliationDifference) > Math.abs(maxRecon)) {
          maxRecon = reconciliationDifference;
        }
      }

      // ---- premium changes (real observations only)
      const premiumChange5m = cur.ltp !== null && s5.ltp !== null ? round4(cur.ltp - s5.ltp) : null;
      const premiumChange15m = cur.ltp !== null && s15.ltp !== null ? round4(cur.ltp - s15.ltp) : null;

      // ---- status
      let dataQualityStatus: OiDataQualityStatus;
      if (args.apiError) dataQualityStatus = "API_ERROR";
      else if (actualTotalOi === null) dataQualityStatus = "INSUFFICIENT_HISTORY";
      else if (staleData) dataQualityStatus = "STALE_DATA";
      else if (args.baseline === null || base.oi === null) dataQualityStatus = "COLLECTING";
      else if (changeOi5m === null && changeOi15m === null && obs.length >= 4) dataQualityStatus = "INVALID_BASELINE";
      else dataQualityStatus = "VALID";

      // A strike is "invalid" when the provider reports it but the opening
      // baseline has no OI for it (incomplete baseline), or when neither has OI.
      if ((actualTotalOi !== null && base.oi === null) || (actualTotalOi === null && base.oi === null)) {
        invalidStrikes.push(strike);
      }

      return {
        openingOi: base.oi,
        openingBaselineAt: args.baseline ? args.baseline.at : null,
        actualTotalOi,
        actualOiAt,
        changeOi30s,
        changeOi5m,
        changeOi15m,
        cumulativeChangeOi,
        combinedTotalOi,
        reconciliationDifference,
        dataQualityStatus,
        baselineStatus: args.baseline ? args.baseline.status : "PENDING",
        observationCount: obs.filter((o) => o.strikes.get(strike)?.ceOi !== null || o.strikes.get(strike)?.peOi !== null).length,
        lastObservationAt: latest ? latest.t : null,
        premiumChange5m,
        premiumChange15m,
        positioningInterpretation: interpretPositioning(changeOi5m ?? cumulativeChangeOi, premiumChange5m),
      };
    };
    return { strike, ce: build("ce"), pe: build("pe") };
  });

  // ---- continuous cumulative-change history for the session chart
  const baselineStikes = args.baseline?.strikes;
  const history = obs.map((o) => {
    let ce: number | null = null;
    let pe: number | null = null;
    if (baselineStikes) {
      // Aggregate the cumulative change across the focus band so the chart is
      // readable, using only real observations (no interpolation).
      let ceSum = 0, peSum = 0, ceN = 0, peN = 0;
      for (const st of (focusStrikes.length ? focusStrikes : ladder)) {
        const b = baselineStikes.get(st);
        const c = o.strikes.get(st);
        if (!b || !c) continue;
        if (c.ceOi !== null && b.ceOi !== null) { ceSum += c.ceOi - b.ceOi; ceN++; }
        if (c.peOi !== null && b.peOi !== null) { peSum += c.peOi - b.peOi; peN++; }
      }
      ce = ceN > 0 ? round4(ceSum) : null;
      pe = peN > 0 ? round4(peSum) : null;
    }
    return { t: o.t, ce, pe };
  });

  // ---- overall data quality
  let status: OiDataQualityStatus;
  if (args.apiError) status = "API_ERROR";
  else if (!args.fromProvider || !latest) status = "COLLECTING";
  else if (staleData) status = "STALE_DATA";
  else if (args.baseline === null) status = "COLLECTING";
  else if (reconciliationStrikes > 0) status = "RECONCILIATION_WARNING";
  else status = "VALID";

  const notes: string[] = [
    "Combined Total OI is DERIVED (opening baseline + cumulative change) — it is not an exchange-reported value.",
    "Actual Total OI comes directly from the Upstox option chain and is never computed by adding change OI.",
    "Positioning interpretations are probabilistic; OI alone does not identify any participant.",
  ];
  if (args.baseline?.status === "LATE_CAPTURE") {
    notes.push(`Opening baseline captured at ${new Date(args.baseline.at + 5.5 * 3_600_000).toISOString().slice(11, 19)} IST — the first genuine observation available, NOT a fabricated 09:15 value.`);
  }
  if (reconciliationStrikes > 0) {
    notes.push(`RECONCILIATION_WARNING: ${reconciliationStrikes} strike(s) differ between Combined and Actual OI (max ${maxRecon}). Possible missing observations, timing differences, provider updates or contract mismatch — neither value was overwritten.`);
  }
  if (missingIntervals > 0) notes.push(`${missingIntervals} polling gap(s) detected — gaps are not interpolated.`);

  return {
    underlyingKey: args.underlyingKey,
    symbol: args.symbol,
    expiry: args.expiry,
    spot: args.spot,
    atmStrike,
    focusStrikes,
    ladder,
    fromProvider: args.fromProvider,
    strikes,
    history,
    dataQuality: {
      status,
      baselineStatus: args.baseline ? args.baseline.status : "PENDING",
      openingBaselineAt: args.baseline ? args.baseline.at : null,
      observationCount: obs.length,
      lastObservationAt: latest ? latest.t : null,
      missingIntervals,
      staleData,
      maxReconciliationDifference: maxRecon,
      reconciliationStrikes,
      invalidStrikes: [...new Set(invalidStrikes)],
      apiError: args.apiError ?? null,
      notes,
    },
    capturedAt: now,
  };
}

function momentumKeys(
  b: { strikes: Map<number, StrikeObservation> } | null | undefined
): number[] {
  return b ? [...b.strikes.keys()] : [];
}
