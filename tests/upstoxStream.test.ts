import { describe, expect, it } from "vitest";
import { decodeMarketDataFeed } from "../src/lib/market/upstoxStream";

function v(n: number): number[] {
  const out: number[] = [];
  let x = n;
  while (x > 127) { out.push((x & 0x7f) | 0x80); x = Math.floor(x / 128); }
  out.push(x);
  return out;
}
function bytesField(field: number, value: number[]): number[] {
  return [...v(field * 8 + 2), ...v(value.length), ...value];
}
function varintField(field: number, value: number): number[] {
  return [...v(field * 8), ...v(value)];
}
function doubleField(field: number, value: number): number[] {
  const b = Buffer.alloc(8); b.writeDoubleLE(value, 0);
  return [...v(field * 8 + 1), ...b];
}

describe("Upstox V3 protobuf decoder", () => {
  it("decodes an LTPC feed map entry without fabricating depth", () => {
    const ltpc = [
      ...doubleField(1, 25123.5),
      ...varintField(2, 1_800_000_000_000),
      ...varintField(3, 25),
      ...doubleField(4, 25000),
    ];
    const feed = bytesField(1, ltpc);
    const entry = [...bytesField(1, [...Buffer.from("NSE_INDEX|Nifty 50")]), ...bytesField(2, feed)];
    const response = [
      ...varintField(1, 1),
      ...bytesField(2, entry),
      ...varintField(3, 1_800_000_000_100),
    ];
    const decoded = decodeMarketDataFeed(new Uint8Array(response));
    expect(decoded.quotes).toHaveLength(1);
    expect(decoded.quotes[0].instrumentKey).toBe("NSE_INDEX|Nifty 50");
    expect(decoded.quotes[0].ltp).toBe(25123.5);
    expect(decoded.quotes[0].ltq).toBe(25);
    expect(decoded.quotes[0].bids).toHaveLength(0);
    expect(decoded.quotes[0].volumeCum).toBeNull();
  });
  it("decodes full-market depth, cumulative volume and OI", () => {
    const ltpc = [...doubleField(1, 100.25), ...varintField(2, 1_800_000_000_000), ...varintField(3, 15), ...doubleField(4, 99.5)];
    const quote = [...varintField(1, 5000), ...doubleField(2, 100.2), ...varintField(3, 3200), ...doubleField(4, 100.3)];
    const marketLevel = bytesField(1, quote);
    const marketFull = [
      ...bytesField(1, ltpc), ...bytesField(2, marketLevel),
      ...varintField(6, 125000), ...doubleField(7, 42000),
    ];
    const fullFeed = bytesField(1, marketFull);
    const feed = bytesField(2, fullFeed);
    const entry = [...bytesField(1, [...Buffer.from("NSE_EQ|TEST")]), ...bytesField(2, feed)];
    const response = [...varintField(1, 1), ...bytesField(2, entry), ...varintField(3, 1_800_000_000_100)];
    const decoded = decodeMarketDataFeed(new Uint8Array(response));
    expect(decoded.quotes[0].bids[0]).toEqual({ p: 100.2, q: 5000 });
    expect(decoded.quotes[0].asks[0]).toEqual({ p: 100.3, q: 3200 });
    expect(decoded.quotes[0].volumeCum).toBe(125000);
    expect(decoded.quotes[0].oi).toBe(42000);
  });

});
