import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MissingCredentialsError,
  buildPreHash,
  credentialsFromEnv,
  sign,
  signedGet,
  signedHeaders,
  signedPost,
  withBuildPrefix,
} from "../src/signer";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TS = "2026-05-11T10:08:57.715Z";
const PATH = "/build/api/v1/dex/aggregator/supported/chain";
// Computed independently with .NET HMACSHA256 over the same preHash.
const EXPECTED_SIGN = "LSo8B/uQsCH5dOEQpxEIHwgLl82bC8c0Ryw2E7aiTXQ=";

describe("signer", () => {
  it("builds the preHash as timestamp + METHOD + /build path + body", () => {
    expect(buildPreHash(TS, "get", PATH)).toBe(`${TS}GET${PATH}`);
    expect(buildPreHash(TS, "POST", "/build/api/v1/x", '{"a":1}')).toBe(`${TS}POST/build/api/v1/x{"a":1}`);
  });

  it("matches an independently computed HMAC-SHA256 Base64 signature", () => {
    expect(sign(buildPreHash(TS, "GET", PATH), "test-secret")).toBe(EXPECTED_SIGN);
  });

  it("adds /build exactly once and keeps the query string", () => {
    expect(withBuildPrefix("/api/v1/dex/aggregator/supported/chain")).toBe(PATH);
    expect(withBuildPrefix("api/v1/x?a=1&b=2")).toBe("/build/api/v1/x?a=1&b=2");
    expect(withBuildPrefix("/build/api/v1/x")).toBe("/build/api/v1/x");
  });

  it("signs the /build path even when the caller omits it", () => {
    const h = signedHeaders("GET", "/api/v1/dex/aggregator/supported/chain", { apiKey: "k", apiSecret: "test-secret" }, "", new Date(TS));
    expect(h).toEqual({ "X-OC-APIKEY": "k", "X-OC-TIMESTAMP": TS, "X-OC-SIGN": EXPECTED_SIGN });
  });

  it("re-signs each retry with a fresh timestamp after a 429", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return seen.length === 1
        ? new Response(JSON.stringify({ code: 42900, msg: "Too many requests" }), { status: 429 })
        : new Response(JSON.stringify({ code: 0, msg: "success", data: ["ok"] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const data = await signedGet("/api/v1/x", { apiKey: "k", apiSecret: "s" }, { backoffMs: 5 });
    expect(data).toEqual(["ok"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://web3.binance.com/build/api/v1/x");
    expect(seen[0]?.["X-OC-TIMESTAMP"]).not.toBe(seen[1]?.["X-OC-TIMESTAMP"]);
    expect(seen[0]?.["X-OC-SIGN"]).not.toBe(seen[1]?.["X-OC-SIGN"]);
  });

  it("signs POST requests over the exact JSON body it sends", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ code: 0, data: { status: "SUCCESS" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const creds = { apiKey: "k", apiSecret: "s" };
    const body = { binanceChainId: "56", evmTx: { from: "0xa", to: "0xb", data: "0x", value: "0" } };
    await expect(signedPost("/api/v1/dex/pre-transaction/simulate", body, creds)).resolves.toEqual({ status: "SUCCESS" });
    const init = fetchMock.mock.calls[0]![1];
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(body));
    expect(headers["Content-Type"]).toBe("application/json");
    const expected = sign(buildPreHash(headers["X-OC-TIMESTAMP"]!, "POST", "/build/api/v1/dex/pre-transaction/simulate", JSON.stringify(body)), "s");
    expect(headers["X-OC-SIGN"]).toBe(expected);
  });

  it("does not retry signature errors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 40102, msg: "Invalid signature" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(signedGet("/api/v1/x", { apiKey: "k", apiSecret: "s" }, { backoffMs: 5 })).rejects.toMatchObject({ code: 40102 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads credentials from env and fails clearly when missing", () => {
    expect(credentialsFromEnv({ BW3_API_KEY: " k ", BW3_API_SECRET: "s" })).toEqual({ apiKey: "k", apiSecret: "s" });
    expect(() => credentialsFromEnv({ BW3_API_KEY: "k" })).toThrow(MissingCredentialsError);
    expect(() => credentialsFromEnv({})).toThrow(MissingCredentialsError);
  });
});
