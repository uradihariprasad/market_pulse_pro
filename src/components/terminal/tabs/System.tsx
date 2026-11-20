"use client";

import { ShieldCheck, Database, Cpu, BookOpenCheck, Scale } from "lucide-react";
import type { TerminalPayload, StatusPayload } from "../ui";
import { CapTag, fmtIst } from "../ui";

const AUDIT_DECLARATIONS = [
  "Every price, OI and volume figure comes from Upstox (historical candle API, market-quote API, option-chain API or instrument master). No mock prices, fabricated OI, synthetic depth or hardcoded recommendations exist anywhere in the system.",
  "Delta/CVD/footprint are ESTIMATED from streamed cumulative-volume increments and quote/tick rules, with REST fallback. Exact exchange aggressor-side classification is UNAVAILABLE.",
  "OI-only option strikes feed the S/R engine strictly as OI_CANDIDATE provenance and can only be upgrade-marked by real price-action confirmation; provenance is preserved after upgrade.",
  "Pivots require 3 closed confirmation bars; historical signals never consume a pivot before it would have been knowable in real time (no look-ahead).",
  "Relative volume compares cumulative session volume with avgDailyVol × elapsed-session-fraction — never a forming candle against a completed one.",
  "OI snapshots are timestamped in PostgreSQL; intraday ΔOI is computed against the session's first (SESSION_REF) snapshot — provider prev-oi (prior-day) is never mixed in.",
  "Missing bars are reported as gaps, never filled with fabricated values. Stale quotes (>25s) downgrade the quality flag; degraded regimes expire outstanding signals.",
  "The scanner produces zero candidates when no scenario satisfies its conditions. Confluence scores are deterministic aggregates, explicitly not win probabilities.",
  "The Upstox token lives only on the server (PostgreSQL settings + memory); UI receives a boolean connection status. Error messages redact credentials.",
  "PCR(OI) and PCR(Volume) are computed on separate, labelled bases and never mixed.",
];

export default function System({ payload }: { payload: TerminalPayload }) {
  const s = payload.status;
  return (
    <div className="fade-in grid gap-4 lg:grid-cols-2">
      {/* capability matrix */}
      <div className="panel overflow-hidden lg:col-span-2">
        <div className="flex items-center gap-2 border-b border-slate-800 p-3">
          <Cpu size={14} className="text-cyan-300" />
          <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Capability matrix — what is exact, estimated, unavailable</h3>
        </div>
        <div className="scroll-thin overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Feature</th><th>Status</th><th>Method</th><th>Honest limitation</th></tr></thead>
            <tbody>
              {s.capabilities.map((c) => (
                <tr key={c.feature}>
                  <td className="whitespace-normal text-slate-200">{c.feature}</td>
                  <td><CapTag status={c.status} /></td>
                  <td className="whitespace-normal text-[11px] text-slate-400">{c.method}</td>
                  <td className="whitespace-normal text-[11px] text-slate-500">{c.limitation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* feature status matrix (Phase 5.9) */}
      <div className="panel overflow-hidden lg:col-span-2">
        <div className="border-b border-slate-800 p-3">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Feature status matrix</h3>
        </div>
        <table className="tbl">
          <thead><tr><th>Module</th><th>Status</th><th>Basis</th></tr></thead>
          <tbody>
            {featureMatrix(s).map((f) => (
              <tr key={f.name}>
                <td className="text-slate-200">{f.name}</td>
                <td><span className={`tag ${f.tone}`}>{f.status}</span></td>
                <td className="whitespace-normal text-[11px] text-slate-500">{f.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* coverage audit + provider diagnostics (Phase 6.16/6.17) */}
      <div className="panel p-4">
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Feed coverage — honest accounting</h3>
        {s.coverage ? (
          <div className="grid grid-cols-1 gap-2 text-[12px] mono sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <KV k="Eligible F&O stocks" v={String(s.coverage.eligibleStocks)} />
            <KV k="Fresh equity quotes" v={String(s.coverage.freshEquityQuotes)} />
            <KV k="Stale equity quotes" v={String(s.coverage.staleEquityQuotes)} />
            <KV k="Last cycle requested" v={String(s.coverage.lastCycleRequested)} />
            <KV k="Last cycle returned" v={String(s.coverage.lastCycleReturned)} />
            <KV k="Valid LTP values" v={String(s.coverage.lastCycleValidLtp)} />
            <KV k="Deferred to next rotation" v={String(s.coverage.deferredToNextRotation)} />
            <KV k="Coverage" v={`${s.coverage.coveragePct}%${s.coverage.fullCoverage ? " (full universe)" : " (partial cycle)"}`} />
            <KV k="Uncovered / no fresh quote" v={String(s.coverage.uncovered)} />
            <KV k="Last scan complete" v={s.scanAt ? fmtIst(s.scanAt) : "—"} />
            <KV k="Focused V3 stream" v={s.transport?.stream?.status ?? "NOT STARTED"} />
            <KV k="Stream subscriptions" v={String(s.transport?.stream?.subscribed ?? 0)} />
            <KV k="Last stream message" v={s.transport?.stream?.lastMessageAt ? fmtIst(s.transport.stream.lastMessageAt) : "—"} />
          </div>
        ) : (
          <p className="text-[12px] text-slate-600">Coverage metrics pending first scan.</p>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
          Upstox V3 streaming is focused on core indices, the selected instrument, its front future and ATM ±3 CE/PE contracts. The broad F&O universe remains REST-polled; provider subscription limits and account entitlements still apply.
        </p>
      </div>

      <div className="panel overflow-hidden lg:col-span-2">
        <h3 className="border-b border-slate-800 p-3 text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Provider diagnostics (sanitized — no secrets)</h3>
        <div className="scroll-thin overflow-x-auto">
          <table className="tbl mono">
            <thead><tr><th>Time</th><th>Endpoint</th><th>HTTP</th><th className="text-right">ms</th><th className="text-right">req</th><th className="text-right">ret</th><th className="text-right">valid LTP</th><th className="text-right">missing</th><th>Note</th></tr></thead>
            <tbody>
              {(s.diagnostics ?? []).length === 0 && (
                <tr><td colSpan={9} className="py-4 text-center text-slate-600">No provider calls yet.</td></tr>
              )}
              {[...(s.diagnostics ?? [])].reverse().map((d, i) => (
                <tr key={i}>
                  <td className="text-slate-500">{fmtIst(d.t)}</td>
                  <td className="text-slate-300">{d.endpoint}</td>
                  <td className={d.http && d.http >= 400 ? "text-rose-300" : "text-slate-200"}>{d.http ?? "—"}</td>
                  <td className="text-right">{d.ms}</td>
                  <td className="text-right">{d.requested}</td>
                  <td className="text-right">{d.returned}</td>
                  <td className="text-right">{d.validLtp}</td>
                  <td className={d.missing > 0 ? "text-right text-amber-300" : "text-right"}>{d.missing}</td>
                  <td className="text-slate-500">{d.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* engine health */}
      <div className="panel p-4">
        <div className="mb-3 flex items-center gap-2">
          <Database size={14} className="text-emerald-300" />
          <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Engine health</h3>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[12px] mono">
          <KV k="Connection" v={s.connection} />
          <KV k="Token" v={s.tokenStatus} />
          <KV k="Transport" v={s.transport ? `${s.transport.mode} · every ${Math.round(s.transport.quoteIntervalMs / 1000)}s` : "—"} />
          <KV k="Poll cycles (ok / failed)" v={s.transport ? `${s.transport.cycles} / ${s.transport.failedCycles}` : "—"} />
          <KV k="Rate-limit waits" v={s.transport ? `${s.transport.rateLimitWaits} (${s.transport.rateLimitWaitedMs}ms)` : "—"} />
          <KV k="Secret storage" v={s.secrets ? `${s.secrets.storage} · key:${s.secrets.keySource}` : "—"} />
          <KV k="Quotes received" v={String(s.counters.quotesReceived)} />
          <KV k="Processed / dropped" v={`${s.counters.quotesProcessed} / ${s.counters.quotesDropped}`} />
          <KV k="Chain fetches" v={String(s.counters.chainFetches)} />
          <KV k="Candle fetches" v={String(s.counters.candleFetches)} />
          <KV k="Errors" v={String(s.counters.errors)} />
          <KV k="Engine started" v={fmtIst(s.startedAt)} />
          <KV k="Last poll" v={s.lastPollAt ? fmtIst(s.lastPollAt) : "—"} />
          <KV k="Last chain" v={s.lastChainAt ? fmtIst(s.lastChainAt) : "—"} />
        </div>
        {s.counters.lastError && (
          <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/5 p-2 text-[11px] text-rose-200/80 mono">
            {s.counters.lastError}
          </p>
        )}
        <div className="mt-3 border-t border-slate-800 pt-3 text-[11px] text-slate-500">
          <p>Universe: {s.universe.loaded ? `${s.universe.foStockCount} F&O-eligible equities from live instrument master (${s.universe.rawCount.toLocaleString()} instruments scanned)` : s.universe.error ?? "loading…"}</p>
          <p className="mt-1">Session elapsed fraction (RVOL expectation basis): {(s.sessionElapsed * 100).toFixed(0)}%</p>
        </div>
      </div>

      {/* audit declarations */}
      <div className="panel p-4">
        <div className="mb-3 flex items-center gap-2">
          <BookOpenCheck size={14} className="text-violet-300" />
          <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Integrity declarations</h3>
        </div>
        <ol className="space-y-2">
          {AUDIT_DECLARATIONS.map((d, i) => (
            <li key={i} className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-400">
              <ShieldCheck size={12} className="mt-0.5 shrink-0 text-emerald-400" />
              <span>{d}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* disclaimer */}
      <div className="panel border-amber-400/20 p-4 lg:col-span-2">
        <div className="flex items-start gap-3">
          <Scale size={16} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="text-[12px] leading-relaxed text-slate-400">
            <b className="text-slate-200">Decision support only.</b> This terminal estimates, measures and organises market evidence; it does not predict prices
            and does not guarantee profitability or execution outcomes. Options involve substantial risk. Zones, targets and invalidations are
            rule-based references derived from documented methods; always apply independent judgement, position sizing and stop discipline.
            Verify fills, greeks and margin with your broker before acting. Not investment advice; not SEBI-registered research.
          </div>
        </div>
      </div>
    </div>
  );
}

interface FeatureRow { name: string; status: string; tone: string; basis: string }

function featureMatrix(s: StatusPayload): FeatureRow[] {
  const live = s.tokenStatus === "VALID";
  return [
    { name: "Live quotes (full F&O universe)", status: live ? "WORKING" : "UNAVAILABLE", tone: live ? "exact" : "unavailable", basis: live ? `${s.transport?.stream?.fresh ? "V3 stream live for focused instruments" : s.transport?.stream?.connected ? "V3 connected but feed stale" : "V3 stream disconnected / REST fallback"}; broad F&O coverage via REST rotation (${Math.round((s.transport?.quoteIntervalMs ?? 10000) / 1000)}s target)` : "requires Upstox token" },
    { name: "Momentum scanner (F&O equities)", status: live ? "WORKING" : "UNAVAILABLE", tone: live ? "exact" : "unavailable", basis: "real equity quotes, prev close, cum volume, ATP; stale/missing excluded with reasons" },
    { name: "Structure & indicators (BOS/CHoCH, EMA/RSI/ATR)", status: "WORKING", tone: "exact", basis: "validated closed candles; pivot right-bar confirmation (no look-ahead)" },
    { name: "Dynamic S/R engine", status: "WORKING", tone: "exact", basis: "structural + local bid/ask liquidity + OI/premium + estimated CVD; focused SSE updates" },
    { name: "Buyer/Seller liquidity map", status: live ? (s.transport?.stream?.fresh ? "STREAMING" : s.transport?.stream?.connected ? "STALE" : "REST FALLBACK") : "UNAVAILABLE", tone: live ? "estimated" : "unavailable", basis: "displayed bid/ask depth walls and persistence; passive liquidity, not executed volume" },
    { name: "Volume Profile", status: "APPROXIMATE", tone: "approximate", basis: "triangular typical-price allocation of candle volume; conservation-tested; unavailable on zero-volume index bars" },
    { name: "Delta / CVD / Footprint", status: live ? "ESTIMATED" : "UNAVAILABLE", tone: live ? "estimated" : "unavailable", basis: "quote-rule/tick-rule estimate on streamed cumulative-volume increments; REST fallback; unknown volume preserved" },
    { name: "Exact trade-based Delta/CVD", status: "UNAVAILABLE", tone: "unavailable", basis: "provider does not guarantee an exchange aggressor-side flag or complete trade tape" },
    { name: "Market depth (top-5)", status: live ? "PROVIDER" : "UNAVAILABLE", tone: live ? "provider" : "unavailable", basis: "resting book snapshot; never used for aggressor inference" },
    { name: "Option chain + timestamped OI snapshots", status: live ? "WORKING" : "UNAVAILABLE", tone: live ? "provider" : "unavailable", basis: "indices + focused stock; ΔOI vs session reference and vs previous snapshot both tracked" },
    { name: "Trade Finder scenarios + grades", status: "WORKING", tone: "exact", basis: "rule-based; GOOD/POSSIBLE categories defined by score/pending/RR rules — not probabilities" },
    { name: "Watchlist", status: "WORKING", tone: "exact", basis: "PostgreSQL-backed, quote-linked" },
    { name: "News & Events", status: "WORKING", tone: "provider", basis: "public RSS feeds, server-side; unavailable state shown if feeds unreachable" },
    { name: "Historical replay & EOD analytics", status: "WORKING", tone: "exact", basis: "prefix-only recomputation per step; determinism-tested" },
    { name: "Historical tick replay", status: "UNAVAILABLE", tone: "unavailable", basis: "no tick history on provider REST/WS surfaces" },
  ];
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className="text-slate-200">{v}</div>
    </div>
  );
}
