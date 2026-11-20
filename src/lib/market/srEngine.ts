/**
 * Unified Dynamic Support & Resistance engine (Part H).
 *
 * PROVENANCE IS FIRST-CLASS (rule 24):
 *  - STRUCTURAL zones are built from confirmed swings, consolidation bounds,
 *    previous-session levels and (approximate) volume-profile confluence.
 *  - OI_CANDIDATE zones are built ONLY from option-chain positioning. They
 *    can never silently "become" structural via scoring. A candidate is
 *    upgraded to CONFIRMED only when qualifying price-action (wick rejection
 *    / stall) is observed at the zone; the provenance group is preserved
 *    forever and the upgrade is recorded in the source list.
 *  - Structural zones may receive OI confluence as SUPPORTING EVIDENCE
 *    (score bump + source entry), never the other way around.
 *
 * Zone width: volatility-aware (fraction of ATR, clamped by tick multiples)
 * and tick-aligned. Clustering merges nearby levels with a documented
 * tolerance = max(8 ticks, 0.3 * ATR). Scores are deterministic confluence
 * scores — explicitly NOT calibrated win probabilities (rule 9).
 */

import {
  Candle, Zone, ZoneSource, ZoneTouch, StructureEvent,
  alignToTick, round4, istDateKey,
} from "./types";
import type { StructureResult } from "./structure";
import type { ProfileResult } from "./volumeProfile";

export interface OiLevel {
  strike: number;
  ceOi: number;
  peOi: number;
  ceOiChg: number;
  peOiChg: number;
}

export interface SrInput {
  instrumentKey: string;
  timeframeMin: number;
  candles: Candle[]; // resampled; partial last bar allowed for state only
  structure: StructureResult;
  profile: ProfileResult | null;
  oiLevels: OiLevel[] | null;
  tickSize: number;
  atr: number;
  /** Latest session VWAP, when the instrument carries volume. */
  vwap?: number | null;
  prevSessionHigh?: number | null;
  prevSessionLow?: number | null;
  prevSessionClose?: number | null;
  now?: number;
}

interface Cand {
  p: number;
  src: ZoneSource;
  group: "STRUCTURAL" | "OI_CANDIDATE";
}

export function buildZones(inp: SrInput): Zone[] {
  const now = inp.now ?? Date.now();
  const closed = inp.candles.filter((c) => c.closed);
  const n = closed.length;
  if (n < 20) return [];
  const lastClose = closed[n - 1].c;
  const atr = Math.max(inp.atr, inp.tickSize * 4);
  const clusterTol = Math.max(inp.tickSize * 8, atr * 0.3);
  const halfW = Math.min(Math.max(atr * 0.15, inp.tickSize * 2), atr * 0.35);

  // ---------- 1. gather candidates
  const cands: Cand[] = [];

  for (const s of inp.structure.swings) {
    const age = n - 1 - closed.findIndex((c) => c.t >= s.t);
    cands.push({
      p: s.price,
      src: { kind: "SWING", detail: `${s.type === "PIVOT_HIGH" ? "swing high" : "swing low"} ${s.label} (confirmed)`, t: s.confirmedAt, weight: age < 100 ? 1.0 : 0.7 },
      group: "STRUCTURAL",
    });
  }
  if (inp.structure.range?.active) {
    cands.push({ p: inp.structure.range.high, src: { kind: "CONSOLIDATION", detail: `range high, ${inp.structure.range.bars} bars`, t: inp.structure.range.sinceT, weight: 1.2 }, group: "STRUCTURAL" });
    cands.push({ p: inp.structure.range.low, src: { kind: "CONSOLIDATION", detail: `range low, ${inp.structure.range.bars} bars`, t: inp.structure.range.sinceT, weight: 1.2 }, group: "STRUCTURAL" });
  }
  if (inp.prevSessionHigh) cands.push({ p: inp.prevSessionHigh, src: { kind: "PREV_SESSION", detail: "previous session high", t: null, weight: 0.9 }, group: "STRUCTURAL" });
  if (inp.prevSessionLow) cands.push({ p: inp.prevSessionLow, src: { kind: "PREV_SESSION", detail: "previous session low", t: null, weight: 0.9 }, group: "STRUCTURAL" });
  if (inp.prevSessionClose) cands.push({ p: inp.prevSessionClose, src: { kind: "PREV_SESSION", detail: "previous session close", t: null, weight: 0.8 }, group: "STRUCTURAL" });

  if (inp.profile && inp.profile.mode === "APPROXIMATE") {
    const w = 1.0;
    if (inp.profile.poc) cands.push({ p: inp.profile.poc, src: { kind: "PROFILE_POC", detail: "POC (ESTIMATED volume profile)", t: null, weight: w }, group: "STRUCTURAL" });
    if (inp.profile.vah) cands.push({ p: inp.profile.vah, src: { kind: "PROFILE_VAH", detail: "Value area high (ESTIMATED)", t: null, weight: 0.9 }, group: "STRUCTURAL" });
    if (inp.profile.val) cands.push({ p: inp.profile.val, src: { kind: "PROFILE_VAL", detail: "Value area low (ESTIMATED)", t: null, weight: 0.9 }, group: "STRUCTURAL" });
    // HVN = acceptance shelves (S/R candidates);
    // LVN = thin areas price tends to traverse quickly (target / trigger zones)
    for (const h of (inp.profile.hvn ?? []).slice(0, 4)) {
      cands.push({ p: h, src: { kind: "PROFILE_HVN", detail: "High volume node (ESTIMATED) — acceptance shelf", t: null, weight: 0.7 }, group: "STRUCTURAL" });
    }
    for (const l of (inp.profile.lvn ?? []).slice(0, 4)) {
      cands.push({ p: l, src: { kind: "PROFILE_LVN", detail: "Low volume node (ESTIMATED) — thin area, fast traversal", t: null, weight: 0.45 }, group: "STRUCTURAL" });
    }
  }
  // session VWAP as a dynamic reference level (price-derived, volume-weighted)
  if (inp.vwap !== undefined && inp.vwap !== null && Number.isFinite(inp.vwap)) {
    cands.push({ p: inp.vwap, src: { kind: "VWAP", detail: "session VWAP (volume-weighted, computed)", t: null, weight: 0.8 }, group: "STRUCTURAL" });
  }

  // OI-only candidates: strongest call/put OI and |ΔOI| near spot
  const oiCands: Cand[] = [];
  if (inp.oiLevels && inp.oiLevels.length > 0) {
    const near = inp.oiLevels
      .filter((o) => Math.abs(o.strike - lastClose) / lastClose < 0.05)
      .map((o) => ({
        ...o,
        callStrength: o.ceOi + Math.max(o.ceOiChg, 0) * 2,
        putStrength: o.peOi + Math.max(o.peOiChg, 0) * 2,
      }));
    const maxCallStrength = Math.max(1, ...near.map((o) => o.callStrength));
    const maxPutStrength = Math.max(1, ...near.map((o) => o.putStrength));
    const topCalls = [...near].sort((a, b) => b.callStrength - a.callStrength).slice(0, 3);
    const topPuts = [...near].sort((a, b) => b.putStrength - a.putStrength).slice(0, 3);
    const sign = (v: number) => (v > 0 ? `+${fmtCnt(v)}` : v < 0 ? `${fmtCnt(v)}` : "0");
    for (const o of topCalls) {
      if (o.ceOi > 0)
        oiCands.push({
          p: o.strike,
          src: { kind: o.ceOiChg > 0 ? "OPTION_OI_CHANGE" : "OPTION_OI", detail: `Call OI ${fmtCnt(o.ceOi)}${o.ceOiChg ? `, ΔOI (session) ${sign(o.ceOiChg)}` : ""} — OI-only candidate, not confirmed S/R`, t: null, weight: Math.min(1.2, 0.5 + o.callStrength / maxCallStrength / 2) },
          group: "OI_CANDIDATE",
        });
    }
    for (const o of topPuts) {
      if (o.peOi > 0)
        oiCands.push({
          p: o.strike,
          src: { kind: o.peOiChg > 0 ? "OPTION_OI_CHANGE" : "OPTION_OI", detail: `Put OI ${fmtCnt(o.peOi)}${o.peOiChg ? `, ΔOI (session) ${sign(o.peOiChg)}` : ""} — OI-only candidate, not confirmed S/R`, t: null, weight: Math.min(1.2, 0.5 + o.putStrength / maxPutStrength / 2) },
          group: "OI_CANDIDATE",
        });
    }
  }

  // ---------- 2. cluster each group separately
  const clusters = (list: Cand[]) => {
    const sorted = [...list].sort((a, b) => a.p - b.p);
    const out: Cand[][] = [];
    for (const c of sorted) {
      const last = out[out.length - 1];
      if (last && Math.abs(c.p - centroid(last)) <= clusterTol) last.push(c);
      else out.push([c]);
    }
    return out;
  };
  const centroid = (arr: Cand[]) => {
    let w = 0;
    let s = 0;
    for (const c of arr) {
      w += c.src.weight;
      s += c.p * c.src.weight;
    }
    return s / Math.max(w, 1e-9);
  };

  const structuralClusters = clusters(cands);
  const oiClusters = clusters(oiCands);

  // ---------- 3 & 4. build zones with touches, reactions, scores
  const makeZone = (cluster: Cand[], group: "STRUCTURAL" | "OI_CANDIDATE"): Zone => {
    const mid0 = centroid(cluster);
    const mid = alignToTick(mid0, inp.tickSize);
    const lower = alignToTick(mid0 - halfW, inp.tickSize);
    const upper = alignToTick(mid0 + halfW, inp.tickSize);
    // Zones entirely ABOVE the last close cap price => RESISTANCE; entirely
    // BELOW floor price => SUPPORT; straddling the close => BOTH.
    const side: Zone["side"] =
      lower > lastClose ? "RESISTANCE" : upper < lastClose ? "SUPPORT" : "BOTH";

    // Count independent interactions, not every consecutive candle spent
    // inside the zone. For each contiguous interaction, retain the strongest
    // observed rejection/bounce so a multi-candle test remains one test.
    const touches: ZoneTouch[] = [];
    const from = Math.max(1, n - 200);
    let interaction: { t: number; price: number; reaction: ZoneTouch["reaction"]; strength: number } | null = null;
    const flushInteraction = () => {
      if (interaction) touches.push({ t: interaction.t, price: interaction.price, reaction: interaction.reaction });
      interaction = null;
    };
    for (let i = from; i < n; i++) {
      const c = closed[i];
      const intersects = c.l <= upper && c.h >= lower;
      if (!intersects) { flushInteraction(); continue; }
      const bodyRange = Math.max(Math.abs(c.c - c.o), inp.tickSize);
      let reaction: ZoneTouch["reaction"] = "PASS";
      let strength = 0;
      if (side !== "SUPPORT" && c.c < lower && c.h >= lower) {
        const upWick = c.h - Math.max(c.c, c.o);
        if (upWick > bodyRange * 1.2 || c.c < closed[i - 1].l) { reaction = "REJECTION"; strength = upWick / bodyRange; }
      }
      if (side !== "RESISTANCE" && c.c > upper && c.l <= upper) {
        const dnWick = Math.min(c.c, c.o) - c.l;
        if (dnWick > bodyRange * 1.2 || c.c > closed[i - 1].h) {
          const bounceStrength = dnWick / bodyRange;
          if (bounceStrength >= strength) { reaction = "BOUNCE"; strength = bounceStrength; }
        }
      }
      if (!interaction) interaction = { t: c.t, price: round4(c.c), reaction, strength };
      else if (strength > interaction.strength) interaction = { t: c.t, price: round4(c.c), reaction, strength };
    }
    flushInteraction();

    // score breakdown (deterministic)
    const breakdown: { k: string; v: number }[] = [];
    const kinds = new Set(cluster.map((c) => c.src.kind));
    const baseW = cluster.reduce((a, c) => a + c.src.weight, 0);
    breakdown.push({ k: "source strength", v: round4(Math.min(2.2, baseW)) });
    const reactions = touches.filter((t) => t.reaction !== "PASS").length;
    breakdown.push({ k: "verified reactions", v: round4(Math.min(2.0, reactions * 0.5)) });
    const lastTouch = touches[touches.length - 1];
    const recentTouch = lastTouch && lastTouch.t >= closed[Math.max(0, n - 21)].t;
    breakdown.push({ k: "recency", v: recentTouch ? 0.6 : touches.length ? 0.2 : 0 });
    if (kinds.has("PROFILE_POC") || kinds.has("PROFILE_VAH") || kinds.has("PROFILE_VAL")) breakdown.push({ k: "volume-profile confluence (approx)", v: 0.8 });
    if (kinds.size > 1) breakdown.push({ k: "multi-source structure", v: round4(0.25 * (kinds.size - 1)) });
    // OI confluence onto STRUCTURAL zones (supporting evidence only)
    if (group === "STRUCTURAL" && inp.oiLevels) {
      const hit = inp.oiLevels.find((o) => Math.abs(o.strike - mid) <= clusterTol);
      if (hit) breakdown.push({ k: "option-OI confluence (supporting)", v: 0.5 });
    }
    const score = round4(breakdown.reduce((a, b) => a + b.v, 0));

    /**
     * CONFIRMATION — requires actual price-action evidence.
     * A high confluence score NEVER confirms a zone on its own (a score is an
     * aggregation of expectations, not observed behaviour).
     *   STRUCTURAL : >= 1 confirmed reaction (rejection/bounce), or it is a
     *                consolidation boundary that price has actually tested.
     *   OI_CANDIDATE: >= 2 confirmed reactions; provenance stays OI_CANDIDATE.
     */
    let confirmation: Zone["confirmationStatus"] = "CANDIDATE";
    const sources = cluster.map((c) => c.src);
    if (group === "STRUCTURAL") {
      if (reactions >= 1) confirmation = "CONFIRMED";
      else if (kinds.has("CONSOLIDATION") && touches.length >= 2) confirmation = "CONFIRMED";
    } else if (reactions >= 2) {
      confirmation = "CONFIRMED";
      sources.push({
        kind: "SWING",
        detail: "price-action confirmation at OI zone (repeated rejection/stall) — provenance remains OI_CANDIDATE",
        t: lastTouch?.t ?? null,
        weight: 0,
      });
    }

    /**
     * STATE — behavioural lifecycle based on ACCEPTANCE, not a single wick.
     * A break requires either two consecutive closes beyond the zone, or one
     * close beyond it by more than 0.5·ATR (decisive acceptance).
     */
    const last = closed[n - 1];

    // Role-independent TRAVERSAL: price was on one side of the level earlier
    // in the window and has now accepted on the other side. This is what it
    // means for a level to have failed, regardless of whether the level is
    // currently classified support or resistance (classification follows the
    // current price, so a failed support becomes a resistance and vice versa).
    const windowStart = Math.max(0, n - 200);
    let traversedAt = 0;
    let reclaimedAt = 0;
    let breakDirection: "DOWN" | "UP" | null = null;
    let lifecycle: "BROKEN_DOWN" | "BROKEN_UP" | "RECLAIMED" | null = null;
    let seenAbove = false;
    let seenBelow = false;
    for (let i = windowStart; i < n; i++) {
      const c = closed[i];
      const p = closed[Math.max(0, i - 1)];
      const acceptedDown = (c.c < lower && p.c < lower) || c.c < lower - atr * 0.5;
      const acceptedUp = (c.c > upper && p.c > upper) || c.c > upper + atr * 0.5;
      if (c.c < lower) {
        if (seenAbove && acceptedDown) {
          if (lifecycle === "BROKEN_UP") {
            lifecycle = "RECLAIMED"; reclaimedAt = c.t;
          } else {
            lifecycle = "BROKEN_DOWN"; breakDirection = "DOWN"; traversedAt = c.t; reclaimedAt = 0;
          }
        }
        if (acceptedDown) { seenBelow = true; seenAbove = false; }
      } else if (c.c > upper) {
        if (seenBelow && acceptedUp) {
          if (lifecycle === "BROKEN_DOWN") {
            lifecycle = "RECLAIMED"; reclaimedAt = c.t;
          } else {
            lifecycle = "BROKEN_UP"; breakDirection = "UP"; traversedAt = c.t; reclaimedAt = 0;
          }
        }
        if (acceptedUp) { seenAbove = true; seenBelow = false; }
      }
    }
    const postReclaim = reclaimedAt > 0 ? closed.filter((c) => c.t >= reclaimedAt).slice(-2) : [];
    const reclaimed = lifecycle === "RECLAIMED" && postReclaim.length === 2 && (
      breakDirection === "DOWN" ? postReclaim.every((c) => c.c > upper) : postReclaim.every((c) => c.c < lower)
    );
    const traversedDown = lifecycle === "BROKEN_DOWN" || (lifecycle === "RECLAIMED" && breakDirection === "DOWN");
    const traversedUp = lifecycle === "BROKEN_UP" || (lifecycle === "RECLAIMED" && breakDirection === "UP");
    const roleReversed = traversedDown
      ? last.c < lower && touches.some((t) => t.t > traversedAt && t.reaction === "REJECTION")
      : traversedUp
        ? last.c > upper && touches.some((t) => t.t > traversedAt && t.reaction === "BOUNCE")
        : false;

    // reaction trend for strengthening/weakening (recent half vs earlier half)
    const half = Math.ceil(touches.length / 2);
    const earlyReact = touches.slice(0, half).filter((t) => t.reaction !== "PASS").length;
    const lateReact = touches.slice(half).filter((t) => t.reaction !== "PASS").length;

    let state: Zone["state"];
    if ((traversedDown || traversedUp) && reclaimed) state = "RECLAIMED";
    else if ((traversedDown || traversedUp) && roleReversed) state = "ROLE_REVERSED";
    else if (traversedDown || traversedUp) state = "BROKEN";
    else if (last.c <= upper && last.c >= lower) {
      // inside the zone → which edge is price pressing?
      state = last.c >= mid ? "BREAKOUT_RISK" : "BREAKDOWN_RISK";
    } else if (reactions >= 2 && lateReact >= earlyReact) state = "STRENGTHENING";
    else if (reactions >= 2 && lateReact < earlyReact) state = "WEAKENING";
    else if (reactions >= 1) state = "CONFIRMED";
    else if (touches.length > 0) state = "DEVELOPING";
    else state = "CANDIDATE";

    const invalidation =
      side === "RESISTANCE" ? alignToTick(upper + atr * 0.5, inp.tickSize)
      : side === "SUPPORT" ? alignToTick(lower - atr * 0.5, inp.tickSize)
      : alignToTick(last.c >= mid ? upper + atr * 0.5 : lower - atr * 0.5, inp.tickSize);

    const id = `${inp.instrumentKey}|${inp.timeframeMin}m|${group}|${side}|${Math.round(mid / clusterTol)}`;
    return {
      id, instrumentKey: inp.instrumentKey, timeframeMin: inp.timeframeMin,
      side, lower, upper, mid,
      provenanceGroup: group,
      confirmationStatus: confirmation,
      state, score, breakdown, sources, touches: touches.slice(-12),
      invalidation,
      createdAt: cluster.reduce((min, c) => (c.src.t && c.src.t < min ? c.src.t : min), now),
      updatedAt: now,
    };
  };

  const zones = [
    ...structuralClusters.map((c) => makeZone(c, "STRUCTURAL")),
    ...oiClusters.map((c) => makeZone(c, "OI_CANDIDATE")),
  ];

  // drop distant/irrelevant zones, rank deterministically
  const relevant = zones.filter(
    (z) => Math.abs(z.mid - lastClose) / lastClose < 0.08 || z.provenanceGroup === "OI_CANDIDATE"
  );
  const byScore = [...relevant].sort((a, b) => b.score - a.score || a.mid - b.mid);
  const nearestSupport = relevant.filter((z) => z.side === "SUPPORT" || (z.side === "BOTH" && z.mid < lastClose)).sort((a, b) => b.mid - a.mid).slice(0, 6);
  const nearestResistance = relevant.filter((z) => z.side === "RESISTANCE" || (z.side === "BOTH" && z.mid > lastClose)).sort((a, b) => a.mid - b.mid).slice(0, 6);
  const selected = new Map<string, Zone>();
  for (const z of [...nearestSupport, ...nearestResistance, ...byScore.slice(0, 16)]) selected.set(z.id, z);
  return [...selected.values()].sort((a, b) => b.score - a.score || a.mid - b.mid).slice(0, 28);
}

function fmtCnt(v: number): string {
  if (v >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/**
 * Primary zone selection.
 *
 * Correctness rules (the chart, scanner and signal engine all call THIS, so
 * they can never disagree):
 *  - primary support must sit BELOW the current price, resistance ABOVE;
 *  - BROKEN zones are never returned as active S/R; ROLE_REVERSED zones are
 *    eligible on the new side after a failed retest, and RECLAIMED zones are
 *    eligible again after acceptance back on the original side;
 *  - CONFIRMED zones outrank unconfirmed candidates at similar distance;
 *  - selection is by proximity, never by raw score alone.
 */
export function zoneMap(
  price: number,
  zones: Zone[]
): { nearestSupport: Zone | null; nearestResistance: Zone | null; distSupPct: number | null; distResPct: number | null } {
  /**
   * Preference order: zones that have NOT been traversed are preferred, but a
   * traversed (BROKEN/flipped) level is still the nearest structural
   * reference — so it is used as a fallback rather than leaving the side
   * empty. The zone keeps its BROKEN state in the payload, so the chart and
   * trade panel always label it instead of presenting it as an intact level.
   */
  const intact = zones.filter((z) => z.state !== "BROKEN");
  const pick = (pool: Zone[]) => {
    let s: Zone | null = null;
    let r: Zone | null = null;
    for (const z of pool) {
      if (z.upper <= price || (z.side !== "RESISTANCE" && z.mid <= price)) {
        if (better(z, s, true)) s = z;
      }
      if (z.lower >= price || (z.side !== "SUPPORT" && z.mid >= price)) {
        if (better(z, r, false)) r = z;
      }
    }
    return { s, r };
  };
  let sup: Zone | null = null;
  let res: Zone | null = null;
  const better = (cand: Zone, cur: Zone | null, isSup: boolean): boolean => {
    if (!cur) return true;
    const closer = isSup ? cand.mid > cur.mid : cand.mid < cur.mid;
    const sameBand = Math.abs(cand.mid - cur.mid) / Math.max(price, 1) < 0.001;
    if (sameBand) {
      // tie-break: confirmed beats unconfirmed, then higher score
      const cc = cand.confirmationStatus === "CONFIRMED" ? 1 : 0;
      const kc = cur.confirmationStatus === "CONFIRMED" ? 1 : 0;
      if (cc !== kc) return cc > kc;
      return cand.score > cur.score;
    }
    return closer;
  };
  const primary = pick(intact);
  const fallback = pick(zones);
  sup = primary.s ?? fallback.s;
  res = primary.r ?? fallback.r;
  return {
    nearestSupport: sup,
    nearestResistance: res,
    distSupPct: sup ? round4(((price - sup.mid) / price) * 100) : null,
    distResPct: res ? round4(((res.mid - price) / price) * 100) : null,
  };
}

export type { StructureEvent };
