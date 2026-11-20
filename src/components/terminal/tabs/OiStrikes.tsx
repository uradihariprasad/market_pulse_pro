"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Loader2, AlertTriangle, Crosshair, Info, RefreshCw } from "lucide-react";
import type { TerminalPayload } from "../ui";
import { fmtCnt, fmtNum, fmtIst } from "../ui";

// ---------------- canonical view types (mirror src/lib/market/oiCanonical.ts)
interface Side {
  openingOi: number | null; openingBaselineAt: number | null;
  actualTotalOi: number | null; actualOiAt: number | null;
  changeOi30s: number | null; changeOi5m: number | null; changeOi15m: number | null;
  cumulativeChangeOi: number | null; combinedTotalOi: number | null;
  reconciliationDifference: number | null;
  dataQualityStatus: string; baselineStatus: string;
  observationCount: number; lastObservationAt: number | null;
  premiumChange5m: number | null; premiumChange15m: number | null;
  positioningInterpretation: string;
}
interface Strike { strike: number; ce: Side; pe: Side }
interface OiPayload {
  underlyingKey: string; symbol: string; expiry: string; spot: number | null;
  atmStrike: number | null; focusStrikes: number[]; ladder: number[]; fromProvider: boolean;
  strikes: Strike[];
  history: { t: number; ce: number | null; pe: number | null }[];
  dataQuality: {
    status: string; baselineStatus: string; openingBaselineAt: number | null;
    observationCount: number; lastObservationAt: number | null; missingIntervals: number;
    staleData: boolean; maxReconciliationDifference: number | null; reconciliationStrikes: number;
    invalidStrikes: number[]; apiError: string | null; notes: string[];
  };
  capturedAt: number;
}
interface OiResponse {
  ok: boolean; state: string; error?: string; oi?: OiPayload;
  expiries?: string[]; tokenStatus?: string;
}

export default function OiStrikes({ payload }: { payload: TerminalPayload }) {
  const catalog = useMemo(() => payload.chainCatalog ?? [], [payload.chainCatalog]);
  const [selected, setSelected] = useState("");
  const [res, setRes] = useState<OiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState(3);
  const [showTable, setShowTable] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!selected && catalog.length > 0) setSelected((catalog.find((c) => c.isIndex) ?? catalog[0]).underlyingKey);
  }, [catalog, selected]);

  const load = useCallback(async (key: string) => {
    if (!key) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const r = await fetch(`/api/oi?instrumentKey=${encodeURIComponent(key)}`, { cache: "no-store" });
      if (id !== seq.current) return;
      setRes((await r.json()) as OiResponse);
    } catch {
      if (id === seq.current) setRes({ ok: false, state: "FAILED", error: "network error" });
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const boot = setTimeout(() => void load(selected), 0);
    const t = setInterval(() => void load(selected), 20000);
    return () => { clearTimeout(boot); clearInterval(t); };
  }, [selected, load]);

  const oi = res?.ok ? res.oi : undefined;
  const entry = catalog.find((c) => c.underlyingKey === selected);
  const expiries = res?.expiries ?? entry?.expiries ?? [];

  const visible = useMemo(() => {
    if (!oi) return [];
    const i = oi.atmStrike !== null ? oi.ladder.indexOf(oi.atmStrike) : -1;
    if (i < 0 || range >= 999) return oi.ladder;
    return oi.ladder.slice(Math.max(0, i - range), Math.min(oi.ladder.length, i + range + 1));
  }, [oi, range]);

  const dq = oi?.dataQuality;

  return (
    <div className="fade-in space-y-4">
      {/* A. HEADER */}
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <BarChart3 size={15} className="text-cyan-300" />
          <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">OI Strike Intelligence</h2>
          <select className="select-slim mono w-full sm:w-auto sm:max-w-[240px]" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <optgroup label="Indices">
              {catalog.filter((c) => c.isIndex).map((c) => <option key={c.underlyingKey} value={c.underlyingKey}>{c.symbol}</option>)}
            </optgroup>
            <optgroup label="F&O stocks">
              {catalog.filter((c) => !c.isIndex).slice(0, 250).map((c) => <option key={c.underlyingKey} value={c.underlyingKey}>{c.symbol}</option>)}
            </optgroup>
          </select>
          <button onClick={() => void load(selected)} disabled={loading} className="flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300 disabled:opacity-50">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
          </button>
          <div className="flex overflow-hidden rounded-lg border border-slate-700">
            {[3, 5, 10, 20, 999].map((n) => (
              <button key={n} onClick={() => setRange(n)} className={`px-2.5 py-1.5 text-[10px] font-bold ${range === n ? "bg-cyan-400/15 text-cyan-300" : "text-slate-500"}`}>
                {n === 999 ? "Full" : `ATM±${n}`}
              </button>
            ))}
          </div>
          {oi && (
            <span className="mono ml-auto text-[10px] text-slate-500">
              spot {fmtNum(oi.spot, 2)} · ATM {oi.atmStrike ?? "—"} · {oi.ladder.length} strikes · {oi.dataQuality.observationCount} obs
            </span>
          )}
        </div>
        {oi && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
            <span className="mono text-slate-400">expiry <b className="text-slate-200">{oi.expiry}</b></span>
            <span className="mono text-slate-400">chain updated {fmtIst(oi.dataQuality.lastObservationAt)}</span>
            <span className={`tag ${dq?.status === "VALID" ? "exact" : dq?.status === "RECONCILIATION_WARNING" ? "unavailable" : "estimated"}`}>
              {dq?.status.replace(/_/g, " ").toLowerCase()}
            </span>
            <span className={`tag ${dq?.baselineStatus === "PERSISTED" ? "exact" : dq?.baselineStatus === "LATE_CAPTURE" ? "estimated" : "unavailable"}`}>
              baseline {dq?.baselineStatus.toLowerCase()}{dq?.openingBaselineAt ? ` ${fmtIst(dq.openingBaselineAt)}` : ""}
            </span>
            <span className="mono text-slate-500">ATM±3: {oi.focusStrikes.join(", ") || "—"}</span>
          </div>
        )}
      </div>

      {/* non-loaded states */}
      {res && !oi && (
        <div className="panel grid place-items-center p-12 text-center">
          <AlertTriangle size={22} className="mb-3 text-amber-400" />
          <p className="text-sm font-semibold text-slate-300">
            {res.state === "UNSUPPORTED" ? "No listed option contracts"
              : res.state === "REQUIRES_TOKEN" ? "OI data requires an Upstox token"
              : res.state === "PENDING" ? "Option chain queued" : "Request failed"}
          </p>
          <p className="mt-1 max-w-lg text-[12px] text-slate-500">{res.error}</p>
          <span className={`tag mt-3 ${res.state === "PENDING" ? "estimated" : "unavailable"}`}>{res.state}</span>
        </div>
      )}

      {oi && (
        <>
          {/* B. FIVE PANELS */}
          <div className="grid gap-4 xl:grid-cols-2">
            <ChangePanel title="1 · 5-Minute Change OI" strikes={oi.strikes} visible={visible} focus={oi.focusStrikes} atm={oi.atmStrike} spot={oi.spot} pick="changeOi5m" />
            <ChangePanel title="2 · 15-Minute Change OI" strikes={oi.strikes} visible={visible} focus={oi.focusStrikes} atm={oi.atmStrike} spot={oi.spot} pick="changeOi15m" />
            <ChangePanel title="3 · Cumulative Change OI (from opening)" strikes={oi.strikes} visible={visible} focus={oi.focusStrikes} atm={oi.atmStrike} spot={oi.spot} pick="cumulativeChangeOi" />
            <TotalPanel title="4 · Combined Total OI (derived)" strikes={oi.strikes} visible={visible} focus={oi.focusStrikes} atm={oi.atmStrike} spot={oi.spot} pick="combinedTotalOi" note="opening baseline + cumulative change" />
            <TotalPanel title="5 · Actual Total OI (Upstox)" strikes={oi.strikes} visible={visible} focus={oi.focusStrikes} atm={oi.atmStrike} spot={oi.spot} pick="actualTotalOi" note="provider-reported — never derived" />
            {/* D. continuous history */}
            <HistoryPanel history={oi.history} />
          </div>

          {/* reconciliation banner */}
          {dq && dq.reconciliationStrikes > 0 && (
            <div className="panel border-amber-400/30 bg-amber-400/5 p-3 text-[11px] text-amber-200">
              <b>RECONCILIATION_WARNING:</b> {dq.reconciliationStrikes} strike(s) differ between Combined and Actual OI
              (max {fmtCnt(dq.maxReconciliationDifference)}). Neither value was overwritten — investigate missing
              observations, timing differences, provider updates or contract mismatch.
            </div>
          )}

          {/* C. intelligence table */}
          <div className="panel overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3">
              <Crosshair size={14} className="text-cyan-300" />
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Strike-wise intelligence</h3>
              <button onClick={() => setShowTable((v) => !v)} className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">
                {showTable ? "hide" : "show"} full table
              </button>
              <span className="mono ml-auto text-[10px] text-slate-500">{visible.length} of {oi.ladder.length} strikes</span>
            </div>
            {showTable && (
              <div className="scroll-thin overflow-x-auto">
                <table className="tbl mono">
                  <thead><tr>
                    <th>Strike</th>
                    <th className="text-right">CE Actual</th><th className="text-right">CE Combined</th>
                    <th className="text-right">CE 5m</th><th className="text-right">CE 15m</th><th className="text-right">CE Cum</th>
                    <th className="text-right">PE Actual</th><th className="text-right">PE Combined</th>
                    <th className="text-right">PE 5m</th><th className="text-right">PE 15m</th><th className="text-right">PE Cum</th>
                    <th>Positioning</th><th>State</th>
                  </tr></thead>
                  <tbody>
                    {oi.strikes.filter((s) => visible.includes(s.strike)).map((s) => (
                      <tr key={s.strike} className={s.strike === oi.atmStrike ? "bg-cyan-400/[0.07]" : oi.focusStrikes.includes(s.strike) ? "bg-slate-700/20" : undefined}>
                        <td className="font-bold text-slate-100">{s.strike}{s.strike === oi.atmStrike ? " ◄" : ""}</td>
                        <Num v={s.ce.actualTotalOi} />
                        <Num v={s.ce.combinedTotalOi} recon={s.ce.reconciliationDifference} />
                        <Chg v={s.ce.changeOi5m} />
                        <Chg v={s.ce.changeOi15m} />
                        <Chg v={s.ce.cumulativeChangeOi} />
                        <Num v={s.pe.actualTotalOi} />
                        <Num v={s.pe.combinedTotalOi} recon={s.pe.reconciliationDifference} />
                        <Chg v={s.pe.changeOi5m} />
                        <Chg v={s.pe.changeOi15m} />
                        <Chg v={s.pe.cumulativeChangeOi} />
                        <td><span className={`tag ${s.ce.positioningInterpretation.includes("LONG") ? "exact" : s.ce.positioningInterpretation.includes("WRITING") ? "estimated" : ""}`}>
                          {s.ce.positioningInterpretation.replace(/POSSIBLE_|_/g, " ").toLowerCase().trim()}
                        </span></td>
                        <td><span className={`tag ${s.ce.dataQualityStatus === "VALID" ? "exact" : s.ce.dataQualityStatus === "COLLECTING" ? "estimated" : "unavailable"}`}>
                          {s.ce.dataQualityStatus.replace(/_/g, " ").toLowerCase()}
                        </span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* E. data quality */}
          <div className="panel p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Info size={13} className="text-blue-300" />
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Data quality</h3>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px] mono sm:grid-cols-4 lg:grid-cols-6">
              <KV k="Status" v={dq?.status.replace(/_/g, " ").toLowerCase() ?? "—"} />
              <KV k="Baseline" v={dq?.baselineStatus.toLowerCase() ?? "—"} />
              <KV k="Baseline at" v={dq?.openingBaselineAt ? fmtIst(dq.openingBaselineAt) : "—"} />
              <KV k="Observations" v={String(dq?.observationCount ?? 0)} />
              <KV k="Last obs" v={dq?.lastObservationAt ? fmtIst(dq.lastObservationAt) : "—"} />
              <KV k="Missing intervals" v={String(dq?.missingIntervals ?? 0)} />
              <KV k="Stale" v={dq?.staleData ? "yes" : "no"} />
              <KV k="Recon strikes" v={String(dq?.reconciliationStrikes ?? 0)} />
              <KV k="Max recon diff" v={dq?.maxReconciliationDifference !== null && dq?.maxReconciliationDifference !== undefined ? fmtCnt(dq.maxReconciliationDifference) : "—"} />
              <KV k="Invalid strikes" v={dq?.invalidStrikes.length ? String(dq.invalidStrikes.length) : "0"} />
              <KV k="From provider" v={oi.fromProvider ? "yes" : "no"} />
              <KV k="API error" v={dq?.apiError ? dq.apiError.slice(0, 18) : "none"} />
            </div>
            <div className="mt-3 space-y-1">
              {dq?.notes.map((n, i) => <p key={i} className="text-[10px] leading-relaxed text-slate-500">▸ {n}</p>)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- panels

function ChangePanel({
  title, strikes, visible, focus, atm, spot, pick,
}: {
  title: string; strikes: Strike[]; visible: number[]; focus: number[];
  atm: number | null; spot: number | null; pick: "changeOi5m" | "changeOi15m" | "cumulativeChangeOi";
}) {
  const rows = strikes.filter((s) => visible.includes(s.strike));
  const max = Math.max(...rows.flatMap((r) => [Math.abs(r.ce[pick] ?? 0), Math.abs(r.pe[pick] ?? 0)]), 1);
  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">{title}</h3>
        <Legend />
      </div>
      <div className="scroll-thin max-h-[300px] overflow-y-auto p-2">
        {rows.map((r) => {
          const isAtm = r.strike === atm;
          const isFocus = focus.includes(r.strike);
          return (
            <div key={r.strike} className={`flex items-center gap-1.5 rounded px-1 py-[3px] ${isAtm ? "bg-cyan-400/10" : isFocus ? "bg-slate-700/20" : ""}`}>
              <span className={`mono w-14 shrink-0 text-right text-[10px] ${isAtm ? "font-bold text-cyan-300" : isFocus ? "text-slate-200" : "text-slate-500"}`}>
                {r.strike}{isAtm ? " ◄" : ""}
              </span>
              <div className="flex h-3.5 min-w-0 flex-1 justify-end overflow-hidden rounded-sm bg-slate-900/60" title={`CE ${r.ce[pick] ?? "unavailable"}`}>
                <div className={`h-full ${(r.ce[pick] ?? 0) < 0 ? "bg-rose-400/35" : "bg-rose-400/70"}`} style={{ width: `${Math.min(100, (Math.abs(r.ce[pick] ?? 0) / max) * 100)}%` }} />
              </div>
              <div className="flex h-3.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-slate-900/60" title={`PE ${r.pe[pick] ?? "unavailable"}`}>
                <div className={`h-full ${(r.pe[pick] ?? 0) < 0 ? "bg-emerald-400/35" : "bg-emerald-400/70"}`} style={{ width: `${Math.min(100, (Math.abs(r.pe[pick] ?? 0) / max) * 100)}%` }} />
              </div>
            </div>
          );
        })}
        {spot !== null && <p className="mono mt-2 px-1 text-[9px] text-slate-600">spot {fmtNum(spot, 2)} · ATM ◄ · faded = negative</p>}
      </div>
    </div>
  );
}

function TotalPanel({
  title, strikes, visible, focus, atm, spot, pick, note,
}: {
  title: string; strikes: Strike[]; visible: number[]; focus: number[];
  atm: number | null; spot: number | null; pick: "combinedTotalOi" | "actualTotalOi"; note: string;
}) {
  const rows = strikes.filter((s) => visible.includes(s.strike));
  const max = Math.max(...rows.flatMap((r) => [r.ce[pick] ?? 0, r.pe[pick] ?? 0]), 1);
  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">{title}</h3>
        <Legend />
        <span className="mono ml-auto text-[9px] text-slate-500">{note}</span>
      </div>
      <div className="scroll-thin max-h-[300px] overflow-y-auto p-2">
        {rows.map((r) => {
          const isAtm = r.strike === atm;
          const isFocus = focus.includes(r.strike);
          return (
            <div key={r.strike} className={`flex items-center gap-1.5 rounded px-1 py-[3px] ${isAtm ? "bg-cyan-400/10" : isFocus ? "bg-slate-700/20" : ""}`}>
              <span className={`mono w-14 shrink-0 text-right text-[10px] ${isAtm ? "font-bold text-cyan-300" : isFocus ? "text-slate-200" : "text-slate-500"}`}>
                {r.strike}{isAtm ? " ◄" : ""}
              </span>
              <div className="flex h-3.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-slate-900/60">
                <div className="h-full bg-rose-400/70" style={{ width: `${Math.min(100, ((r.ce[pick] ?? 0) / max) * 100)}%` }} title={`CE ${r.ce[pick] ?? "unavailable"}`} />
              </div>
              <div className="flex h-3.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-slate-900/60">
                <div className="h-full bg-emerald-400/70" style={{ width: `${Math.min(100, ((r.pe[pick] ?? 0) / max) * 100)}%` }} title={`PE ${r.pe[pick] ?? "unavailable"}`} />
              </div>
            </div>
          );
        })}
        {spot !== null && <p className="mono mt-2 px-1 text-[9px] text-slate-600">spot {fmtNum(spot, 2)}</p>}
      </div>
    </div>
  );
}

function HistoryPanel({ history }: { history: { t: number; ce: number | null; pe: number | null }[] }) {
  const w = 880, h = 190, pad = 10;
  const vals = history.flatMap((x) => [x.ce, x.pe]).filter((v): v is number => v !== null);
  if (history.length < 2 || vals.length === 0) {
    return (
      <div className="panel overflow-hidden">
        <div className="border-b border-slate-800 p-3"><h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Continuous cumulative change OI</h3></div>
        <div className="grid h-[190px] place-items-center text-[12px] text-slate-600">
          Collecting observations — the session chart appears once genuine history exists.
        </div>
      </div>
    );
  }
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const span = Math.max(max - min, 1);
  const x = (i: number) => pad + (i / Math.max(history.length - 1, 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const line = (key: "ce" | "pe") =>
    history.map((p, i) => (p[key] === null ? null : `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key] as number).toFixed(1)}`))
      .filter(Boolean).join(" ");
  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Continuous cumulative change OI</h3>
        <span className="mono ml-auto text-[9px] text-slate-500">{history.length} observations · ATM±3 aggregate</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: 190 }} preserveAspectRatio="none">
        <line x1={pad} y1={y(0)} x2={w - pad} y2={y(0)} stroke="#27344a" strokeDasharray="4 4" strokeWidth="1" />
        <path d={line("ce")} fill="none" stroke="#f87171" strokeWidth="1.6" />
        <path d={line("pe")} fill="none" stroke="#34d399" strokeWidth="1.6" />
      </svg>
      <p className="mono px-3 pb-2 text-[9px] text-slate-600">
        {fmtIst(history[0].t)} → {fmtIst(history[history.length - 1].t)} · points are real observations only (no interpolation)
      </p>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex items-center gap-2 text-[9px] text-slate-500">
      <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-rose-400/70" /> CE</span>
      <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-emerald-400/70" /> PE</span>
    </span>
  );
}

function Num({ v, recon }: { v: number | null; recon?: number | null }) {
  const warn = recon !== null && recon !== undefined && Math.abs(recon) > Math.max(1, (v ?? 0) * 0.01);
  return <td className={`text-right ${warn ? "text-amber-300" : "text-slate-300"}`}>{v === null ? "—" : fmtCnt(v)}</td>;
}
function Chg({ v }: { v: number | null }) {
  return (
    <td className={`text-right ${v === null ? "text-slate-600" : v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "text-slate-400"}`}>
      {v === null ? "—" : `${v > 0 ? "+" : ""}${fmtCnt(v)}`}
    </td>
  );
}
function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5">
      <div className="truncate text-[8px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className="truncate text-slate-200">{v}</div>
    </div>
  );
}
