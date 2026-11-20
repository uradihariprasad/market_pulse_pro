import { createRequire } from "node:module";

export interface StreamQuote {
  instrumentKey: string;
  exchangeTs: number | null;
  lastTradeTs: number | null;
  ltp: number | null;
  ltq: number | null;
  volumeCum: number | null;
  oi: number | null;
  bids: { p: number; q: number }[];
  asks: { p: number; q: number }[];
}
export type StreamStatus = "DISCONNECTED" | "CONNECTING" | "LIVE" | "STALE" | "ERROR";

type FeedHandler = (quote: StreamQuote) => void;

function readVarint(buf: Uint8Array, start: number): { value: number; next: number } {
  let value = 0, shift = 0, offset = start;
  while (offset < buf.length && shift < 53) {
    const b = buf[offset++];
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value, next: offset };
    shift += 7;
  }
  throw new Error("Invalid protobuf varint");
}
function readFields(buf: Uint8Array): { no: number; wire: number; value: number | Uint8Array; next: number }[] {
  const out = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset); offset = tag.next;
    const no = Math.floor(tag.value / 8), wire = tag.value & 7;
    if (no <= 0) throw new Error("Invalid protobuf field number");
    if (wire === 0) {
      const v = readVarint(buf, offset); out.push({ no, wire, value: v.value, next: v.next }); offset = v.next;
    } else if (wire === 1) {
      if (offset + 8 > buf.length) throw new Error("Truncated protobuf fixed64");
      const view = Buffer.from(buf.buffer, buf.byteOffset + offset, 8);
      const value = view.readDoubleLE(0); offset += 8; out.push({ no, wire, value, next: offset });
    } else if (wire === 2) {
      const len = readVarint(buf, offset); offset = len.next;
      const end = offset + len.value;
      if (end > buf.length) throw new Error("Truncated protobuf bytes");
      const value = buf.subarray(offset, end); offset = end; out.push({ no, wire, value, next: offset });
    } else if (wire === 5) {
      if (offset + 4 > buf.length) throw new Error("Truncated protobuf fixed32");
      offset += 4;
    } else throw new Error(`Unsupported protobuf wire type ${wire}`);
  }
  return out;
}
function bytes(fields: ReturnType<typeof readFields>, no: number): Uint8Array | null {
  const f = fields.find((x) => x.no === no && x.wire === 2);
  return f && f.value instanceof Uint8Array ? f.value : null;
}
function num(fields: ReturnType<typeof readFields>, no: number): number | null {
  const f = fields.find((x) => x.no === no && (x.wire === 0 || x.wire === 1));
  return f && typeof f.value === "number" ? f.value : null;
}
function parseLtpc(buf: Uint8Array) {
  const f = readFields(buf);
  return { ltp: num(f, 1), ltt: num(f, 2), ltq: num(f, 3), cp: num(f, 4) };
}
function parseDepth(buf: Uint8Array) {
  const f = readFields(buf);
  return { bidQ: num(f, 1) ?? 0, bidP: num(f, 2) ?? 0, askQ: num(f, 3) ?? 0, askP: num(f, 4) ?? 0 };
}
function parseMarketLevel(buf: Uint8Array) {
  return readFields(buf).filter((x) => x.no === 1 && x.wire === 2 && x.value instanceof Uint8Array).map((x) => parseDepth(x.value as Uint8Array));
}
function parseMarketFull(buf: Uint8Array) {
  const f = readFields(buf);
  const ltpcBytes = bytes(f, 1);
  const levelBytes = bytes(f, 2);
  return {
    ltpc: ltpcBytes ? parseLtpc(ltpcBytes) : null,
    depth: levelBytes ? parseMarketLevel(levelBytes) : [],
    volumeCum: num(f, 6), oi: num(f, 7),
  };
}
function parseFirstLevel(buf: Uint8Array) {
  const f = readFields(buf);
  const l = bytes(f, 1), d = bytes(f, 2);
  return { ltpc: l ? parseLtpc(l) : null, depth: d ? [parseDepth(d)] : [], volumeCum: num(f, 4), oi: num(f, 5) };
}
function parseFullFeed(buf: Uint8Array) {
  const f = readFields(buf);
  const market = bytes(f, 1), index = bytes(f, 2);
  if (market) return parseMarketFull(market);
  if (index) {
    const i = readFields(index), l = bytes(i, 1);
    return { ltpc: l ? parseLtpc(l) : null, depth: [], volumeCum: null, oi: null };
  }
  return { ltpc: null, depth: [], volumeCum: null, oi: null };
}
function parseFeed(buf: Uint8Array) {
  const f = readFields(buf);
  const l = bytes(f, 1), full = bytes(f, 2), first = bytes(f, 3);
  if (l) return { ...parseLtpc(l), depth: [], volumeCum: null, oi: null };
  if (full) {
    const x = parseFullFeed(full);
    return { ...(x.ltpc ?? { ltp: null, ltt: null, ltq: null, cp: null }), depth: x.depth, volumeCum: x.volumeCum, oi: x.oi };
  }
  if (first) {
    const x = parseFirstLevel(first);
    return { ...(x.ltpc ?? { ltp: null, ltt: null, ltq: null, cp: null }), depth: x.depth, volumeCum: x.volumeCum, oi: x.oi };
  }
  return null;
}

/** Minimal decoder for the documented Upstox MarketDataFeedV3 protobuf fields used here. */
export function decodeMarketDataFeed(input: Uint8Array): { currentTs: number | null; quotes: StreamQuote[] } {
  const root = readFields(input);
  const currentTs = num(root, 3);
  const quotes: StreamQuote[] = [];
  for (const entry of root.filter((x) => x.no === 2 && x.wire === 2 && x.value instanceof Uint8Array)) {
    const map = readFields(entry.value as Uint8Array);
    const keyBytes = bytes(map, 1);
    const feedBytes = bytes(map, 2);
    if (!keyBytes || !feedBytes) continue;
    const key = Buffer.from(keyBytes).toString("utf8");
    const feed = parseFeed(feedBytes);
    if (!feed || feed.ltp === null || feed.ltp === undefined) continue;
    const depth = feed.depth.filter((x) => x.bidP > 0 || x.askP > 0);
    quotes.push({
      instrumentKey: key, exchangeTs: currentTs,
      lastTradeTs: feed.ltt ?? null, ltp: feed.ltp, ltq: feed.ltq ?? null,
      volumeCum: feed.volumeCum ?? null, oi: feed.oi ?? null,
      bids: depth.filter((x) => x.bidP > 0 && x.bidQ > 0).map((x) => ({ p: x.bidP, q: x.bidQ })),
      asks: depth.filter((x) => x.askP > 0 && x.askQ > 0).map((x) => ({ p: x.askP, q: x.askQ })),
    });
  }
  return { currentTs, quotes };
}

/** Server-only wrapper around the official Upstox Node SDK MarketDataStreamerV3. */
export class UpstoxMarketStream {
  private streamer: any = null;
  private keys = new Set<string>();
  private connected = false;
  private status: StreamStatus = "DISCONNECTED";
  private lastMessageAt: number | null = null;
  private onQuote: FeedHandler | null = null;
  private mode: "full" | "full_d30" = process.env.UPSTOX_STREAM_MODE === "full_d30" ? "full_d30" : "full";
  private onStatus: ((status: StreamStatus, error?: string) => void) | null = null;

  start(token: string, keys: string[], onQuote: FeedHandler, onStatus: (status: StreamStatus, error?: string) => void) {
    if (this.streamer) this.stop();
    this.onQuote = onQuote;
    this.onStatus = onStatus;
    this.keys = new Set(keys);
    this.status = "CONNECTING";
    this.onStatus(this.status);
    try {
      const require = createRequire(`${process.cwd()}/package.json`);
      const sdk = require("upstox-js-sdk");
      const api = sdk.ApiClient.instance;
      api.authentications.OAUTH2.accessToken = token;
      this.mode = process.env.UPSTOX_STREAM_MODE === "full_d30" ? "full_d30" : "full";
      const streamer = new sdk.MarketDataStreamerV3([], this.mode);
      this.streamer = streamer;
      streamer.autoReconnect(true, 5, 20);
      streamer.on("open", () => {
        this.connected = true;
        this.status = "LIVE";
        this.onStatus?.(this.status);
        if (this.keys.size) streamer.subscribe([...this.keys], this.mode);
      });
      streamer.on("message", (data: unknown) => {
        try {
          let decoded: { currentTs: number | null; quotes: StreamQuote[] };
          const raw = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
          const textPayload = typeof data === "string" ? data : raw ? Buffer.from(raw).toString("utf8") : null;
          if (textPayload && textPayload.trimStart().startsWith("{")) {
            const parsed = JSON.parse(textPayload) as { feeds?: Record<string, any>; currentTs?: string | number };
            decoded = { currentTs: Number(parsed.currentTs) || null, quotes: Object.entries(parsed.feeds ?? {}).flatMap(([instrumentKey, v]) => {
              const f = v.fullFeed?.marketFF ?? v.fullFeed?.indexFF ?? v.firstLevelWithGreeks ?? v;
              const l = f.ltpc ?? {};
              const depth = f.marketLevel?.bidAskQuote ?? (f.firstDepth ? [f.firstDepth] : []);
              const ltp = Number(l.ltp);
              return Number.isFinite(ltp) && ltp > 0 ? [{ instrumentKey, exchangeTs: Number(parsed.currentTs) || null, lastTradeTs: Number(l.ltt) || null, ltp, ltq: Number(l.ltq) || null, volumeCum: Number(f.vtt) || null, oi: Number(f.oi) || null, bids: depth.filter((x: any) => Number(x.bidP) > 0 && Number(x.bidQ) > 0).map((x: any) => ({ p: Number(x.bidP), q: Number(x.bidQ) })), asks: depth.filter((x: any) => Number(x.askP) > 0 && Number(x.askQ) > 0).map((x: any) => ({ p: Number(x.askP), q: Number(x.askQ) })) }] : [];
            }) };
          } else {
            if (!raw) return;
            decoded = decodeMarketDataFeed(raw);
          }
          this.lastMessageAt = Date.now();
          for (const q of decoded.quotes) this.onQuote?.(q);
          if (this.status !== "LIVE") { this.status = "LIVE"; this.onStatus?.(this.status); }
        } catch (e) {
          this.status = "ERROR";
          this.onStatus?.(this.status, e instanceof Error ? e.message : "feed decode failed");
        }
      });
      streamer.on("close", () => { this.connected = false; this.status = "DISCONNECTED"; this.onStatus?.(this.status); });
      streamer.on("error", (e: unknown) => { this.status = "ERROR"; this.onStatus?.(this.status, e instanceof Error ? e.message : "stream error"); });
      streamer.on("reconnecting", () => { this.connected = false; this.status = "CONNECTING"; this.onStatus?.(this.status); });
      streamer.on("autoReconnectStopped", (info: unknown) => {
        this.connected = false; this.status = "ERROR";
        this.onStatus?.(this.status, typeof info === "string" ? info : "Upstox stream auto-reconnect exhausted");
      });
      streamer.connect();
    } catch (e) {
      this.status = "ERROR";
      this.onStatus?.(this.status, e instanceof Error ? e.message : "Upstox SDK stream initialization failed");
    }
  }

  setSubscriptions(keys: string[]) {
    const next = new Set(keys.filter(Boolean));
    const add = [...next].filter((x) => !this.keys.has(x));
    const remove = [...this.keys].filter((x) => !next.has(x));
    this.keys = next;
    if (!this.connected || !this.streamer) return;
    if (remove.length) this.streamer.unsubscribe(remove);
    if (add.length) this.streamer.subscribe(add, this.mode);
  }

  stop() {
    try { this.streamer?.disconnect(); } catch { /* best-effort close */ }
    this.streamer = null;
    this.connected = false;
    this.keys.clear();
    this.status = "DISCONNECTED";
    this.onStatus?.(this.status);
  }

  getState() {
    const fresh = this.connected && this.lastMessageAt !== null && Date.now() - this.lastMessageAt <= 25_000;
    return { status: this.connected && !fresh ? "STALE" as const : this.status, connected: this.connected, fresh, mode: this.mode, lastMessageAt: this.lastMessageAt, subscribed: this.keys.size };
  }
}
