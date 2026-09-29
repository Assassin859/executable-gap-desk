# DX log

Running log of developer-experience issues hit while building Executable Gap Desk against the Binance Web3 APIs, the Binance Skills Hub and the Agentic Wallet CLI (`baw`). Every entry was reproduced by hand; dates are UTC. This log feeds the final DX report.

Conventions: public RWA endpoints are under `https://www.binance.com/bapi/defi` and need the headers `User-Agent: binance-web3/1.1 (Skill)` and `Accept-Encoding: identity`. The keyed API is `https://web3.binance.com/build/...`. The vendor docs snapshot used for citations is [`docs/vendor/llms-full.txt`](vendor/llms-full.txt) (fetched 2026-09-29 14:22 UTC, 438,952 characters).

| # | Date | Area | Severity | Summary |
|---|------|------|----------|---------|
| 1 | 2026-09-29 | Docs | High | `llms.txt` / `llms-full.txt` return a WAF challenge to agents |
| 2 | 2026-09-29 | Skill | High | Skill says Ondo (`type=1`) is the only provider; the list returns 2, 3, 4 and 9 |
| 3 | 2026-09-29 | RWA API | High | Dynamic v2 returns nulls for xStocks and bStocks (session, holders, stock price) |
| 4 | 2026-09-29 | RWA API | Medium | `nextOpen` / `nextClose` are unlabeled sub-session boundaries |
| 5 | 2026-09-29 | Skill | Medium | `volume24h` is the underlying stock's volume, not the token's |
| 6 | 2026-09-29 | Skill | Low | Wallet skill still ships an expired `campaign.md` |
| 7 | 2026-09-29 | RWA API | High | xStocks prices are stale (MSTRx -10.9%, GMEx +894%) with no timestamp |
| 8 | 2026-09-29 | Trading docs | Medium | `40374` is filed under Ondo/BStock errors but is what xStocks returns |
| 9 | 2026-09-29 | Market API | Medium | Keyed `rwa/platforms` omits xStocks |
| 10 | 2026-09-29 | Trading docs | Medium | No market-session endpoint in the keyed docs; hours only appear as RFQ errors |
| 11 | 2026-09-29 | `baw` / Trading | Medium | Ondo minimum is $5 via `baw` but $20 via RFQ |
| 12 | 2026-09-29 | `baw` | Low | Ondo pair error prints a raw `({0})` placeholder |
| 13 | 2026-09-29 | `baw` | Medium | Windows: libuv `async.c` assertion crash after error responses |
| 14 | 2026-09-29 | RWA API | Low | `dividendYield` units differ by platform (percent vs fraction) |
| 15 | 2026-09-29 | RWA API | Medium | List reports `sharesMultiplier = 1` for every xStock; dynamic has real values |
| 16 | 2026-09-29 | Trading docs | High | Docs say Ondo is always `RFQ`; every live Ondo and bStocks quote is `SWAP` via LiquidMesh |
| 17 | 2026-09-29 | Trading API | High | `/quote` returns 88–99.95% price-impact routes with no warning (MSFTon: ~$1B per share) |
| 18 | 2026-09-29 | Trading docs | Medium | `priceImpactPercent` is a 0–1 fraction, not a percent |
| 19 | 2026-09-29 | Trading docs | Medium | `tradeFee` is the network fee in USD and `estimateGasFee` is a gas limit; neither is documented |
| 20 | 2026-09-29 | Trading docs | Medium | No response schema for `/quote`; fields had to be reverse-engineered |
| 21 | 2026-09-29 | Gateway | Medium | A 5-token burst plus refill trips the 5 RPS endpoint limit (`42900`) |

---

## 1. `llms.txt` and `llms-full.txt` return a WAF challenge to curl and agents

- **Repro**
  ```bash
  curl -s -o /dev/null -D - https://web3.binance.com/en/dev-docs/llms-full.txt
  ```
- **Expected:** `200 text/plain` with the docs. These files exist specifically so LLM agents can read them.
- **Actual:** `HTTP/1.1 202 Accepted`, `Content-Length: 0`, `x-amzn-waf-action: challenge`. Same for `llms.txt`. Only a real browser session that solves the JS challenge gets the text.
- **Impact:** coding agents (Cursor, Claude Code, Codex) silently get an empty file and fall back to guessing. We had to fetch it through a browser tab and vendor a copy.
- **Suggested fix:** exempt `/dev-docs/llms*.txt` (and ideally the Markdown doc pages) from the WAF challenge, or mirror them to a static CDN/GitHub path.

## 2. Skill says Ondo is the only provider, but the list returns types 2, 3, 4 and 9

- **Repro:** `skills/binance-web3/binance-tokenized-securities-info/SKILL.md` in `binance/binance-skills-hub` documents the list `type` parameter as "`1` = Ondo Finance (currently the only supported tokenized stock provider)" and the response field as "`1` = Ondo". Then call the list endpoint without `type`:
  ```bash
  curl -s -H 'User-Agent: binance-web3/1.1 (Skill)' -H 'Accept-Encoding: identity' \
    'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai'
  ```
- **Expected:** the skill lists every `type` value the endpoint can return, and each item carries an issuer/platform name.
- **Actual:** items come back with `type` 1 (Ondo, `*on`), 2 (xStocks, `*x`), 3 (bStocks, `*B`), plus 4 and 9, and there is no issuer field. We inferred the mapping from symbol suffixes; the Trading API docs (line 2246 of `llms-full.txt`) confirm `type=2` is xStock, but the skill does not.
- **Suggested fix:** document all type values (including what 4 and 9 are) in the skill, and add `platformName` to each list item.

## 3. Dynamic v2 is empty for xStocks and bStocks

- **Repro:** call the dynamic v2 endpoint for `NVDAon`, `NVDAx` and `NVDAB` on chain 56 (see `packages/core/test/fixtures/dynamic.json`).
- **Expected:** the same shape for every platform, since the skill presents this as a generic tokenized-stock endpoint.
- **Actual:** for `NVDAx` and `NVDAB`, `statusInfo` only has `openState` and `reasonCode`; `marketStatus`, `nextOpenTime` and `nextCloseTime` are `null`. `totalHolders` and `marketCap` are `null`, and for `NVDAB` `stockInfo.price` is also `null`. Only Ondo (`NVDAon`: 58,068 holders, session `regular`) is fully populated.
- **Impact:** no session for two of three platforms, and bStocks cannot provide its own reference price. `gap matrix` flags these rows `STATUS_MISSING` and takes the reference from the Ondo/xStocks row of the same ticker.
- **Suggested fix:** populate `statusInfo` and `stockInfo` for all platforms, or return an explicit `supported: false` per block instead of silent nulls.

## 4. `nextOpen` / `nextClose` are unlabeled sub-session boundaries

- **Repro:** call market status during the US regular session (fixture `packages/core/test/fixtures/market-status.json`, 2026-09-29):
  ```json
  { "marketStatus": "regular", "openState": true,
    "nextOpen": "2026-09-29T20:01:00Z", "nextClose": "2026-09-29T19:59:00Z" }
  ```
- **Expected:** either the next open/close of the *US trading day*, or explicit fields such as `currentSessionEnd` and `nextSession: "postmarket"`.
- **Actual:** `nextClose` (19:59) comes before `nextOpen` (20:01), because they bound a 2-minute break between regular and after-hours. Which pair you get depends on the current state, and nothing says which session each timestamp belongs to. The same happens in premarket.
- **Suggested fix:** return `currentSession`, `currentSessionEndsAt`, `nextSession`, `nextSessionStartsAt`, and document the gaps between sessions.

## 5. `volume24h` is the underlying stock's volume

- **Repro:** the skill's example response shows `"volume24h": "8202859508.959922580629343392"` for an Ondo token. Compare live values with on-chain DEX volume for the same token.
- **Expected:** 24h traded volume of the token on-chain, since every other `tokenInfo` field describes the token.
- **Actual:** the value tracks the underlying US stock's dollar volume (billions), orders of magnitude above the token's on-chain volume.
- **Impact:** agents that use it as a liquidity signal badly overestimate how much they can trade.
- **Suggested fix:** rename to `underlyingVolume24h` or move it under `stockInfo`, and add a real `tokenVolume24h`.

## 6. Wallet skill still ships an expired `campaign.md`

- **Repro:** `skills/binance-web3/binance-agentic-wallet/references/campaign.md` in `binance/binance-skills-hub` states "Campaign validity: 2026-08-17 09:00:00 ~ 2026-09-01 00:00:00 (UTC)".
- **Expected:** expired campaign material is removed, or the skill clearly skips it.
- **Actual:** as of 2026-09-29 the file is still referenced by the skill and loaded into agent context, spending tokens and tempting the agent to suggest an ended campaign.
- **Suggested fix:** remove it after the end date, or gate it behind a date check in the skill instructions.

## 7. xStocks prices are stale, with no timestamp

- **Repro:** `pnpm gap matrix --ticker MSTR GME SPY` (2026-09-29, US regular session):

  | Venue | Per share | Reference | Displayed gap |
  |-------|-----------|-----------|---------------|
  | MSTRon | $155.44 | $155.77 | -0.21% |
  | MSTRB | $155.47 | $155.77 | -0.19% |
  | MSTRx | $138.86 | $155.77 | **-10.86%** |
  | GMEx | $237.69 | $23.92 | **+893.88%** |

  MSTRx showed the same $138.86 at 13:20 UTC (premarket) and again after the open, while the stock moved.
- **Expected:** live prices, or a `priceUpdatedAt` so clients can detect staleness.
- **Actual:** static prices with no update time. GMEx looks like a missed ~10:1 corporate action. 43 xStocks on BSC have no price at all.
- **Impact:** a naive "arbitrage" agent sees MSTRx as 11% cheap. It is not fillable (see #8).
- **Suggested fix:** add `priceUpdatedAt` and a `priceSource` to `tokenInfo`, and null out prices older than a threshold.

## 8. `40374` is filed under Ondo/BStock errors but is what xStocks returns

- **Repro:** signed `GET /build/api/v1/dex/aggregator/quote` for $25 USDT into `AAPLx`, `NVDAx` or `MSTRx` on chain 56 returns `40374 RWA_INSUFFICIENT_LIQUIDITY`.
- **Expected:** xStocks-specific guidance, since the overview (line 2211) says xStock trades "through regular AMM liquidity pools", unlike Ondo/BStock RFQ.
- **Actual:** `40374` is only defined in the "RFQ Orders (Equity Token Errors)" table (line 3093), whose intro says the codes "apply specifically to ... Ondo and BStock tokens". Nothing tells an integrator that xStocks (all three we tried) hit this code, or why.
- **Suggested fix:** move `40374` to a general RWA section, and state in the RWA overview which platforms are actually quotable through the aggregator today.

## 9. Keyed `rwa/platforms` omits xStocks

- **Repro:** signed `GET /build/api/v1/dex/market/rwa/platforms?chainIndex=56`.
- **Expected:** all three platforms that the public list returns for BSC (Ondo, xStocks, bStocks).
- **Actual:** only `ondo` and `bstock`, while the public list returns 128 xStocks on BSC.
- **Suggested fix:** either list xStocks with a `tradable: false` flag, or document why the keyed and public views of RWA platforms differ.

## 10. No market-session endpoint in the keyed docs

- **Repro:** search `docs/vendor/llms-full.txt` for "market status", "marketStatus" or "session": no matches. Market hours only appear as the RFQ constraint row "Ondo tokens may be unavailable outside US market hours (error 40367); BStock similarly (40369)" (line 2286) and in the error tables.
- **Expected:** the Trading API links to an endpoint that says whether the market is open, and when it opens next, before you try to quote.
- **Actual:** the only session endpoint is the unkeyed `/rwa/market/status/ai` in the Skills Hub. Keyed-API integrators learn about hours by hitting `40367`/`40369`.
- **Suggested fix:** add a keyed `GET /api/v1/dex/market/rwa/market-status` (or document the public one) and link it from the RFQ and error sections.

## 11. Ondo minimum order disagrees between `baw` and RFQ

- **Repro:**
  - `baw market-order quote` for under $5 of USDT into an Ondo token on BSC fails with `315008 "From token value greater than 5 USD"`.
  - The docs for `40375 ONDO_FROM_USD_AMOUNT_TOO_SMALL` (line 3106) give "Minimum order amount is 20 USD." as the RFQ minimum.
- **Expected:** one documented minimum per token, or the minimum returned by a metadata endpoint before quoting.
- **Actual:** $5 through the wallet CLI, $20 through RFQ. bStocks quote at $1. The docs say "the exact minimum is returned in the `msg`", so clients must parse English text.
- **Suggested fix:** expose `minOrderUsd` per token (e.g. in `rwa/tokens`) and state which route each minimum applies to.

## 12. Ondo pair error prints a raw `({0})` placeholder

- **Repro:** `baw market-order quote` from BNB into an Ondo token on BSC.
- **Expected:** a message naming the allowed stablecoin (USDT on BSC).
- **Actual:** the message contains the literal template placeholder `({0})` instead of the token list.
- **Suggested fix:** fill the template (it maps to `40368 ONDO_STABLECOIN_PAIR_INVALID`), and suggest the two-step BNB to USDT to Ondo route.

## 13. Windows: `baw` crashes with a libuv assertion after error responses

- **Repro:** on Windows 11 (PowerShell or Git Bash), `baw` v1.10.0: run any command that returns an API error, e.g. the Ondo quote in #12.
- **Expected:** JSON error on stdout, exit code 1.
- **Actual:** the JSON error prints, then `Assertion failed: ... src\win\async.c` and the process exits with `-1073740791` (`0xC0000409`, stack buffer overrun). Scripts that check the exit code can't tell a business error from a crash.
- **Suggested fix:** close libuv handles before `process.exit` on the error path (the usual cause of this assertion), and return a stable non-zero code for API errors.

## 14. `dividendYield` units differ by platform

- **Repro:** dynamic v2 for `AAPLon` vs `AAPLx` / `AAPLB` (fixture `dynamic.json`).
- **Expected:** one unit everywhere.
- **Actual:** for Apple, `AAPLon` returns `0.31` (percent) while `AAPLx` and `AAPLB` return `0.00320000` (fraction). Same underlying, a 100x difference in the raw number.
- **Suggested fix:** normalize to a fraction and document the unit.

## 15. List reports `sharesMultiplier = 1` for every xStock

- **Repro:** compare `sharesMultiplier` in the list endpoint with `tokenInfo.sharesMultiplier` in dynamic v2 for `SPYx` (fixtures `list.json` and `dynamic.json`).
- **Expected:** the same multiplier from both endpoints.
- **Actual:** the list says `1` for every xStock; dynamic returns the real value (`SPYx` 1.00571, `AAPLx` 1.00327). Using the list value misprices per-share by the accrued amount (0.57% for SPYx); `gap matrix` flags this as `MULTIPLIER_MISMATCH` and always prefers the dynamic value.
- **Suggested fix:** return the live multiplier in the list, or drop the field there.

## 16. Docs say Ondo always routes via RFQ; live quotes are all SWAP

- **Repro:** signed `GET /build/api/v1/dex/aggregator/quote` from USDT, with `userWalletAddress` set, into every BSC Ondo and bStocks token at $25 (`gap snapshot --all`, 2026-09-29 14:39 UTC, regular session).
- **Expected:** per the docs (lines 2240–2245), Ondo "Always routed via **3-vendor RFQ** ... All routes return `executionMode=RFQ`", and bStocks return a SWAP route plus a PcsXRfq RFQ route.
- **Actual:** all 165 successful quotes (109 Ondo, 56 bStocks) returned a single-vendor `executionMode=SWAP` from `vendorName=LiquidMesh`. No RFQ route was returned for any token. "Rfq Halfmoon" shows up only as a hop inside `dexRouterList`. This also means the $20 RFQ minimum in #11 never applied: Ondo quoted fine at $25 and below.
- **Impact:** a client following the docs builds the EIP-712 `/order/submit` flow and never uses it, and the RFQ-only error codes (`40366`–`40375`) don't cover what actually fails.
- **Suggested fix:** document when RFQ is offered (size, hours, vendor availability), or fix the routing so the documented behavior holds.

## 17. `/quote` returns near-total-loss routes without a warning

- **Repro:** `gap quote MSFTon --usd 25` and `gap check AAOI` (same sweep as #16).
- **Expected:** a quote whose output is worth almost nothing is either refused at quote time or flagged, as `/swap` does with `40463` (price impact above the 90% default, line 3063).
- **Actual:** `/quote` returns `success: true` for them:
  - MSFTon routes WBNB, then USDC, then a Uniswap V4 pool. It returns 0.0000000244 tokens for $25, about $1,024,618,848 per share, with `priceImpactPercent = 0.9995`.
  - 17 venues are above 90% impact and 22 are above 50%.
  - AAOIB displays within 0.2% of the reference but executes at +397%, with impact 0.961. IRENB executes at +732% with impact 0.881, just under the 90% `/swap` guard, so it would go through.
- **Impact:** the displayed price (`rwa/dynamic`) looks healthy while the executable route is a thin pool. Executable Gap Desk exists to catch exactly this. The gate blocks all of these with `GAP_TOO_WIDE` + `DISPLAY_MISMATCH`.
- **Suggested fix:** return a `warnings` array on `/quote` (e.g. `HIGH_PRICE_IMPACT`), and apply the same protection threshold at quote time.

## 18. `priceImpactPercent` is a fraction, not a percent

- **Repro:** the quotes in #17. MSFTon returns `0.9995`, which only matches its 99.95% loss if read as a fraction. Ondo venues that pass the gate all return `0.0043` or less.
- **Expected:** a percent, as the name says, or a documented unit.
- **Actual:** it is a 0–1 fraction. Reading it as a percent turns a 99.95% loss into "about 1%".
- **Suggested fix:** document the unit, or rename the field to `priceImpact` / `priceImpactRatio`.

## 19. `tradeFee` and `estimateGasFee` names don't match their contents

- **Repro:** any `/quote` response (fixture `quotes.json`).
- **Actual:**
  - `tradeFee` is about `0.02` at every size ($25, $100, $500). That is gas × gas price in USD, i.e. the network fee, not a trading fee.
  - `estimateGasFee` is `450000`, which is a gas limit in units, not a fee.
- **Impact:** clients that add `tradeFee` to slippage or show `estimateGasFee` as dollars show wrong costs. We rename them to `networkFeeUsd` and `gasLimit`.
- **Suggested fix:** document both fields with units, or rename them.

## 20. No response schema for `/quote`

- **Repro:** search the docs for the fields in a live `/quote` response (`toToken.decimal`, `tokenUnitPrice`, `router`, `dexRouterList`, `approveTarget`, `isBest`, `feeAmount`).
- **Expected:** a field table like the one the request parameters have.
- **Actual:**
  - The docs cover the request and the flow but give no response schema. Units and nullability had to be inferred from recorded responses, and #18 and #19 come from that guesswork.
  - `router` is a `--`-joined string of addresses rather than an array.
  - Decimals arrive as strings (`"18"`).
- **Suggested fix:** publish a typed response schema (OpenAPI or a field table) with units.

## 21. The 5 RPS per-endpoint limit trips on a standard token bucket

- **Repro:** a token bucket at 5 requests per second with a burst of 5, firing `/quote` requests back to back (the first `gap snapshot --all` run).
- **Expected:** a client that averages 5 RPS stays under a "5 RPS, 1 s window" limit (line 401).
- **Actual:** `42900` on SPYon. A burst of 5 plus refill puts up to 9 requests into one 1-second window. The docs don't say whether the window is fixed or sliding, so a client can't tell which rate is safe.
- **Workaround:** space requests evenly at 4.5 RPS with no burst, and wait at least 1 s after a 429. The full 271-venue sweep then finished in 73 s with zero `42900`s.
- **Suggested fix:** state the window type and give a recommended client pacing.
