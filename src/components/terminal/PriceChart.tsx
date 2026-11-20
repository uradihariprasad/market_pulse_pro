"use client";

/**
 * Price chart — TradingView Lightweight Charts.
 * Renders CLOSED-validated candles (forming bar included but visually dimmed),
 * EMA21/VWAP overlays, S/R zone price-lines (colored by provenance) and
 * structure-event markers (BOS/CHoCH). Times are shifted so wall-clock
 * displays IST without a timezone library.
 */

import { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  ColorType,
  LineStyle,
} from "lightweight-charts";
import type { CandlePayload, ZonePayload, LiquidityLevelPayload } from "./ui";

interface UnifiedLine { price: number; lower: number; upper: number; side: "SUPPORT" | "RESISTANCE"; state: string; score: number; priceConfirmed: boolean; provenance: string }

const IST_SHIFT_S = 19800; // +05:30

export default function PriceChart({
  candles,
  ema21,
  vwap,
  zones,
  markers,
  profile,
  unifiedSR,
  liquidityLevels = [],
  livePrice = null,
  height = 460,
}: {
  candles: CandlePayload[];
  ema21: (number | null)[];
  vwap: (number | null)[];
  zones: ZonePayload[];
  markers: { type: string; level: number; t: number }[];
  profile: { poc: number | null; vah: number | null; val: number | null } | null | undefined;
  /** Server-calculated immediate/primary levels — never recomputed here. */
  unifiedSR?: {
    immediateSupport: UnifiedLine | null;
    primarySupport: UnifiedLine | null;
    immediateResistance: UnifiedLine | null;
    primaryResistance: UnifiedLine | null;
    all: UnifiedLine[];
  } | null;
  liquidityLevels?: LiquidityLevelPayload[];
  livePrice?: number | null;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const dynamicPriceLines = useRef<IPriceLine[]>([]);
  const liquidityCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#7d8ba1",
        fontSize: 11,
        fontFamily: "ui-monospace, Menlo, monospace",
      },
      grid: {
        vertLines: { color: "rgba(26,34,48,0.5)" },
        horzLines: { color: "rgba(26,34,48,0.5)" },
      },
      crosshair: {
        vertLine: { color: "#22d3ee", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#164e63" },
        horzLine: { color: "#22d3ee", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#164e63" },
      },
      rightPriceScale: { borderColor: "#1a2230" },
      timeScale: { borderColor: "#1a2230", timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;
    const overlay = document.createElement("canvas");
    overlay.dataset.role = "liquidity-heatmap";
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "5";
    ref.current.style.position = "relative";
    ref.current.appendChild(overlay);
    liquidityCanvasRef.current = overlay;

    const cs = chart.addCandlestickSeries({
      upColor: "#34d399",
      downColor: "#f87171",
      wickUpColor: "#34d399",
      wickDownColor: "#f87171",
      borderVisible: false,
    });
    candleSeries.current = cs;

    const vol = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: "#334155",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volSeries.current = vol;

    const ema = chart.addLineSeries({ color: "#fbbf24", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    emaSeriesRef.current = ema;
    const vw = chart.addLineSeries({ color: "#60a5fa", lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    vwapSeriesRef.current = vw;

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.contentRect.width <= 0) continue;
        // A compact chart is easier to inspect on a phone while still leaving
        // room for zone/detail panels below. Desktop retains the requested height.
        const responsiveHeight = e.contentRect.width < 640 ? Math.min(height, 340) : height;
        if (ref.current) ref.current.style.height = `${responsiveHeight}px`;
        const overlay = liquidityCanvasRef.current;
        if (overlay) {
          const dpr = window.devicePixelRatio || 1;
          overlay.width = Math.max(1, Math.floor(e.contentRect.width * dpr));
          overlay.height = Math.max(1, Math.floor(e.contentRect.height * dpr));
          overlay.style.width = `${e.contentRect.width}px`;
          overlay.style.height = `${e.contentRect.height}px`;
        }
        chart.applyOptions({
          width: e.contentRect.width,
          height: responsiveHeight,
          timeScale: {
            barSpacing: e.contentRect.width < 640 ? 5 : 7,
            rightOffset: e.contentRect.width < 640 ? 3 : 6,
          },
        });
      }
    });
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.remove();
      liquidityCanvasRef.current?.remove();
      liquidityCanvasRef.current = null;
      chartRef.current = null;
      priceLines.current = [];
      dynamicPriceLines.current = [];
    };
  }, [height]);

  useEffect(() => {
    const cs = candleSeries.current;
    const vol = volSeries.current;
    if (!cs || !vol) return;

    const cd = candles.map((c) => ({
      time: ((c.t / 1000 + IST_SHIFT_S) | 0) as UTCTimestamp,
      open: c.o, high: c.h, low: c.l, close: c.c,
    }));
    cs.setData(cd);
    vol.setData(
      candles.map((c) => ({
        time: ((c.t / 1000 + IST_SHIFT_S) | 0) as UTCTimestamp,
        value: c.v,
        color: c.c >= c.o ? "rgba(52,211,153,0.35)" : "rgba(248,113,113,0.35)",
      }))
    );

    // overlay series: indicators are computed on closed bars; align from tail
    const closedCount = candles.filter((c) => c.closed).length;
    const offset = candles.length - closedCount; // leading partial bars
    const align = (arr: (number | null)[], target: ISeriesApi<"Line"> | null) => {
      if (!target) return;
      const startIdx = Math.max(0, closedCount - arr.length);
      const data = [];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === null) continue;
        const candleIdx = startIdx + i;
        if (candleIdx >= closedCount) break;
        const c = candles[offset + candleIdx];
        data.push({ time: ((c.t / 1000 + IST_SHIFT_S) | 0) as UTCTimestamp, value: arr[i] as number });
      }
      target.setData(data);
    };
    align(ema21, emaSeriesRef.current);
    align(vwap, vwapSeriesRef.current);

    // structure markers
    const candleTimes = new Set(cd.map((c) => c.time as number));
    type Mk = { time: UTCTimestamp; position: "belowBar" | "aboveBar"; color: string; shape: "arrowUp" | "arrowDown"; text: string };
    const mks: Mk[] = [];
    for (const m of markers) {
      if (!["BOS_UP", "BOS_DOWN", "CHOCH_UP", "CHOCH_DOWN"].includes(m.type)) continue;
      const sec = ((m.t / 1000 + IST_SHIFT_S) | 0) as UTCTimestamp;
      if (!candleTimes.has(sec as number)) continue;
      const up = m.type.endsWith("UP");
      mks.push({
        time: sec,
        position: up ? "belowBar" : "aboveBar",
        color: m.type.startsWith("CHOCH") ? "#a78bfa" : up ? "#22d3ee" : "#fb923c",
        shape: up ? "arrowUp" : "arrowDown",
        text: m.type.startsWith("CHOCH") ? "CHoCH" : "BOS",
      });
    }
    // lightweight-charts requires time-sorted markers
    mks.sort((a, b) => (a.time as number) - (b.time as number));
    cs.setMarkers(mks.slice(-12));

    // zone + profile price lines
    for (const pl of priceLines.current) cs.removePriceLine(pl);
    priceLines.current = [];
    const addLine = (price: number, color: string, style: LineStyle, title: string) => {
      const pl = cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
      priceLines.current.push(pl);
    };
    for (const z of zones.slice(0, 12)) {
      const color =
        z.provenanceGroup === "OI_CANDIDATE"
          ? "#a78bfa"
          : z.side === "SUPPORT"
            ? "#34d399"
            : z.side === "RESISTANCE"
              ? "#f87171"
              : "#94a3b8";
      addLine(z.mid, color, z.provenanceGroup === "OI_CANDIDATE" ? LineStyle.Dashed : LineStyle.Solid, `${z.side.slice(0, 3)} ${z.mid.toFixed(0)}`);
      addLine(z.upper, color, LineStyle.SparseDotted, "");
      addLine(z.lower, color, LineStyle.SparseDotted, "");
    }
    if (profile) {
      if (profile.poc !== null) addLine(profile.poc, "#f59e0b", LineStyle.Dashed, "POC");
      if (profile.vah !== null) addLine(profile.vah, "#f59e0b", LineStyle.SparseDotted, "VAH");
      if (profile.val !== null) addLine(profile.val, "#f59e0b", LineStyle.SparseDotted, "VAL");
    }
    chartRef.current?.timeScale().scrollToRealTime();
  }, [candles, ema21, vwap, zones, markers, profile, height]);

  // Fast-changing Unified S/R and liquidity lines update independently from
  // candle history so a 500ms market event never resets the candlestick series.
  useEffect(() => {
    const cs = candleSeries.current;
    if (!cs) return;
    for (const pl of dynamicPriceLines.current) cs.removePriceLine(pl);
    dynamicPriceLines.current = [];
    const addDynamicLine = (price: number, color: string, style: LineStyle, width: 1 | 2 | 3, title: string) => {
      dynamicPriceLines.current.push(cs.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title }));
    };
    if (unifiedSR) {
      const drawn = new Set<string>();
      const four: { l: UnifiedLine | null; label: string; color: string; width: 1 | 2 | 3 }[] = [
        { l: unifiedSR.primarySupport, label: "PRIMARY SUP", color: "#059669", width: 3 },
        { l: unifiedSR.primaryResistance, label: "PRIMARY RES", color: "#dc2626", width: 3 },
        { l: unifiedSR.immediateSupport, label: "IMM SUP", color: "#4ade80", width: 2 },
        { l: unifiedSR.immediateResistance, label: "IMM RES", color: "#f87171", width: 2 },
      ];
      for (const { l, label, color, width } of four) {
        if (!l) continue;
        const key = l.price.toFixed(4);
        if (drawn.has(key)) continue;
        drawn.add(key);
        addDynamicLine(l.price, color, l.priceConfirmed ? LineStyle.Solid : LineStyle.Dashed, width,
          `${label} ${l.priceConfirmed ? "✓" : "◌"} ${l.score.toFixed(0)} · ${l.state.replace(/_/g, " ")}`);
      }
    }
    if (livePrice !== null && Number.isFinite(livePrice) && livePrice > 0) {
      addDynamicLine(livePrice, "#60a5fa", LineStyle.Dotted, 1, `LIVE LTP ${livePrice.toFixed(2)}`);
    }
    for (const level of liquidityLevels.slice(0, 8)) {
      const buyer = level.side === "BUYER";
      addDynamicLine(level.price, buyer ? "rgba(52,211,153,0.85)" : "rgba(248,113,113,0.85)", LineStyle.Dashed, 1,
        `${buyer ? "BID WALL" : "ASK WALL"} ${Math.round(level.quantity).toLocaleString("en-IN")}`);
    }
  }, [unifiedSR, liquidityLevels, livePrice, height]);

  useEffect(() => {
    const canvas = liquidityCanvasRef.current;
    const chart = chartRef.current;
    const series = candleSeries.current;
    if (!canvas || !chart || !series) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = canvas.clientWidth || ref.current?.clientWidth || 1;
      const cssHeight = canvas.clientHeight || ref.current?.clientHeight || height;
      const targetWidth = Math.max(1, Math.floor(cssWidth * dpr));
      const targetHeight = Math.max(1, Math.floor(cssHeight * dpr));
      if (canvas.width !== targetWidth) canvas.width = targetWidth;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const width = canvas.width / dpr;
      const heightPx = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, heightPx);
      const plotWidth = Math.min(width, chart.timeScale().width() || width);
      // Dynamic support/resistance zone bands (drawn before the depth heatmap).
      for (const level of (unifiedSR?.all ?? []).slice(0, 10)) {
        const top = series.priceToCoordinate(level.upper);
        const bottom = series.priceToCoordinate(level.lower);
        if (top === null || bottom === null) continue;
        const y = Math.min(top, bottom);
        const h = Math.max(2, Math.abs(bottom - top));
        const weakening = level.state.includes("WEAKENING") || level.state.includes("BREAKDOWN") || level.state.includes("BREAKOUT");
        const color = weakening ? "245,158,11" : level.side === "SUPPORT" ? "16,185,129" : "244,63,94";
        const alpha = Math.max(0.035, Math.min(0.14, 0.035 + level.score / 1000));
        ctx.fillStyle = `rgba(${color},${alpha})`;
        ctx.fillRect(0, y, plotWidth, h);
        ctx.fillStyle = `rgba(${color},0.9)`;
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(`${level.side} · ${level.state.replace(/_/g, " ")} · ${level.score.toFixed(0)}`, 8, Math.max(11, y - 3));
      }
      if (!liquidityLevels.length) return;
      const maxQty = Math.max(1, ...liquidityLevels.map((x) => x.quantity));
      for (const level of liquidityLevels.slice(0, 12)) {
        const y = series.priceToCoordinate(level.price);
        if (y === null || y < 0 || y > heightPx) continue;
        const intensity = Math.max(0.10, Math.min(0.42, 0.10 + (level.quantity / maxQty) * 0.32));
        const buyer = level.side === "BUYER";
        ctx.fillStyle = buyer ? `rgba(16,185,129,${intensity})` : `rgba(244,63,94,${intensity})`;
        const bandHeight = Math.max(4, Math.min(13, 4 + level.persistence));
        ctx.fillRect(0, y - bandHeight / 2, plotWidth, bandHeight);
        ctx.fillStyle = buyer ? "rgba(167,243,208,.95)" : "rgba(254,205,211,.95)";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(`${buyer ? "BID" : "ASK"} ${Math.round(level.quantity).toLocaleString("en-IN")} · ${level.persistence} obs`, 8, Math.max(11, y - 5));
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [liquidityLevels, unifiedSR, candles, height]);

  return (
    <div
      ref={ref}
      className="w-full overflow-hidden rounded-lg"
      style={{ height, minHeight: 300 }}
      role="img"
      aria-label="Candlestick chart with dynamic support, resistance and indicator overlays"
    />
  );
}
