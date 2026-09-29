import { describe, expect, it } from "vitest";
import {
  MissingCredentialsError,
  buildPreHash,
  credentialsFromEnv,
  sign,
  signedHeaders,
  withBuildPrefix,
} from "../src/signer";

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

  it("reads credentials from env and fails clearly when missing", () => {
    expect(credentialsFromEnv({ BW3_API_KEY: " k ", BW3_API_SECRET: "s" })).toEqual({ apiKey: "k", apiSecret: "s" });
    expect(() => credentialsFromEnv({ BW3_API_KEY: "k" })).toThrow(MissingCredentialsError);
    expect(() => credentialsFromEnv({})).toThrow(MissingCredentialsError);
  });
});
