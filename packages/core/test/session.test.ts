import { describe, expect, it } from "vitest";
import { MarketStatusSchema, StatusInfoSchema, normalizeAssetStatus, normalizeMarketStatus } from "../src/index";
import { fixture } from "./helpers";

const ms = (over: Record<string, unknown>) => MarketStatusSchema.parse({ openState: false, marketStatus: "closed", reasonCode: null, ...over });

// Tue 29 Sep 2026 and Sat 3 Oct 2026, in UTC.
const TUE_2100 = Date.UTC(2026, 8, 29, 21, 0);
const WED_0800 = Date.UTC(2026, 8, 30, 8, 0);
const SAT_1600 = Date.UTC(2026, 9, 3, 16, 0);
const MON_0800 = Date.UTC(2026, 9, 5, 8, 0);

describe("normalizeMarketStatus", () => {
  it("parses the recorded regular session, choosing the soonest future event", () => {
    const raw = MarketStatusSchema.parse(fixture("market-status.json"));
    const s = normalizeMarketStatus(raw, raw.nextCloseTime! - 60_000);
    expect(s.session).toBe("regular");
    expect(s.open).toBe(true);
    expect(s.nextEvent?.type).toBe("close");
    expect(s.offhours?.nextOpen?.getTime()).toBe(raw.offhours?.nextOpenTime);
  });

  it("handles the reversed ordering while open (nextClose earlier than nextOpen)", () => {
    const s = normalizeMarketStatus(
      ms({ marketStatus: "premarket", openState: true, nextOpenTime: WED_0800 + 60_000, nextCloseTime: WED_0800 - 60_000 }),
      WED_0800 - 3_600_000,
    );
    expect(s.nextEvent).toEqual({ type: "close", at: new Date(WED_0800 - 60_000) });
  });

  it("handles closed ordering (nextOpen earlier than nextClose)", () => {
    const s = normalizeMarketStatus(ms({ nextOpenTime: WED_0800, nextCloseTime: WED_0800 + 3_600_000 }), TUE_2100);
    expect(s.session).toBe("closed");
    expect(s.nextEvent?.type).toBe("open");
  });

  it("ignores events already in the past", () => {
    const s = normalizeMarketStatus(ms({ nextOpenTime: TUE_2100 - 1000, nextCloseTime: WED_0800 }), TUE_2100);
    expect(s.nextEvent?.type).toBe("close");
  });

  it("derives weekend on a Saturday with Monday's open more than 24h away", () => {
    const s = normalizeMarketStatus(ms({ nextOpenTime: MON_0800, nextCloseTime: MON_0800 + 3_600_000 }), SAT_1600);
    expect(s.session).toBe("weekend");
  });

  it("derives weekend when the next open is more than 24h away even on a weekday (holiday)", () => {
    const s = normalizeMarketStatus(ms({ nextOpenTime: TUE_2100 + 40 * 3_600_000 }), TUE_2100);
    expect(s.session).toBe("weekend");
  });

  it("keeps a weekday overnight close as closed", () => {
    const s = normalizeMarketStatus(ms({ nextOpenTime: WED_0800 }), TUE_2100);
    expect(s.session).toBe("closed");
  });

  it("passes pause and its reason code through", () => {
    const s = normalizeMarketStatus(ms({ marketStatus: "pause", reasonCode: "MARKET_PAUSED" }), TUE_2100);
    expect(s.session).toBe("pause");
    expect(s.reasonCode).toBe("MARKET_PAUSED");
  });

  it("maps unrecognised status strings to unknown", () => {
    expect(normalizeMarketStatus(ms({ marketStatus: "lunch", openState: true }), TUE_2100).session).toBe("unknown");
  });
});

describe("normalizeAssetStatus", () => {
  const assets = fixture<Record<string, unknown>>("asset-status.json");

  it("reads Ondo's full session", () => {
    const s = normalizeAssetStatus(StatusInfoSchema.parse(assets.NVDAon));
    expect(s.sessionMissing).toBe(false);
    expect(s.session).not.toBe("unknown");
    expect(s.reasonCode).toBe("TRADING");
  });

  it("flags bStocks and xStocks, which return marketStatus null", () => {
    const s = normalizeAssetStatus(StatusInfoSchema.parse(assets.NVDAB));
    expect(s.sessionMissing).toBe(true);
    expect(s.session).toBe("unknown");
    expect(s.open).toBe(true);
  });

  it("surfaces an asset pause reason code", () => {
    const s = normalizeAssetStatus(StatusInfoSchema.parse({ openState: false, marketStatus: "pause", reasonCode: "ASSET_PAUSED" }), TUE_2100);
    expect(s.session).toBe("pause");
    expect(s.reasonCode).toBe("ASSET_PAUSED");
  });

  it("treats a missing statusInfo as unknown", () => {
    expect(normalizeAssetStatus(null)).toMatchObject({ open: null, session: "unknown", sessionMissing: true });
  });
});
