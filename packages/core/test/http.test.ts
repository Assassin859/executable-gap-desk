import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createLimiter, getJson, unwrapEnvelope } from "../src/index";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unwrapEnvelope", () => {
  it("returns data for the public and keyed success envelopes", () => {
    expect(unwrapEnvelope("e", 200, { code: "000000", data: [1], success: true })).toEqual([1]);
    expect(unwrapEnvelope("e", 200, { code: 0, msg: "success", data: { a: 1 } })).toEqual({ a: 1 });
  });

  it("throws ApiError with code and message on failure envelopes", () => {
    expect(() => unwrapEnvelope("quote", 200, { code: 40374, msg: "Insufficient liquidity", data: null, success: false })).toThrow(
      expect.objectContaining({ name: "ApiError", code: 40374, message: "Insufficient liquidity" }),
    );
  });
});

describe("getJson", () => {
  it("retries 5xx responses and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { code: 50001, msg: "unavailable" }))
      .mockResolvedValueOnce(jsonResponse(200, { code: "000000", data: "ok", success: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getJson("https://example.test/x", { retries: 2 })).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry client errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { code: 40102, msg: "Invalid signature" }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await getJson("https://example.test/x", { retries: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(40102);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failure envelope delivered with HTTP 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { code: 40367, msg: "market closed", success: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getJson("https://example.test/x")).rejects.toMatchObject({ code: 40367 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createLimiter", () => {
  it("never runs more than N tasks at once", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
  });
});
