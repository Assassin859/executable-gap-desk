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
| 22 | 2026-09-29 | `baw` docs | Low | Docs say `contract-call` takes no gas limit; CLI 1.10.0 has `--gasLimit` |
| 23 | 2026-09-29 | Trading API | High | `/swap` suggests a fixed 450,000 gas; a live NVDAB swap used 487,900 |
| 24 | 2026-09-29 | Trading API | High | Fresh LiquidMesh quotes fail their own 0.5% minimum in simulation ("Min return not reached") |
| 25 | 2026-09-29 | Trading API | Medium | A Lifi fill landed 0.50% below its quote and simulation, at the minimum |
| 26 | 2026-09-29 | Transaction API | Medium | `/simulate` reverts are HTTP 200 `status: FAILED`; no response schema |
| 27 | 2026-09-29 | Trading docs | Low | `/swap` response is undocumented (`gas` vs `gasLimit`, duplicate fee fields, which contract to approve) |
| 28 | 2026-09-29 | `baw` | Medium | `contract-call preview` returns token amounts as JSON numbers and loses precision |
| 29 | 2026-09-29 | Trading API | Medium | `/quote` answers `40304` to US cloud regions; the docs don't list it for trading |
| 30 | 2026-09-29 | `baw` | High | `market-order swap` executes at once, with no preview or dry run |
| 31 | 2026-09-29 | `baw` | High | `market-order swap` returns an `orderId` one lower than the stored order, and no status |
| 32 | 2026-09-29 | `baw` / Wallet backend | High | `limit-order buy` on bStocks fails with "Raw limit orders are not supported. (2)"; undocumented |
| 33 | 2026-09-29 | `baw` | Medium | bStocks balances differ between `wallet balance`, `balanceOf` and `Transfer` amounts |
| 34 | 2026-09-29 | `baw` | High | `x402-payment preview` marks a Permit2 option `READY_TO_SIGN` while `needApproveFirst` is true |
| 35 | 2026-09-29 | `baw` | Medium | `x402-payment preview` indices are 1-based and reordered by balance, not the server's `accepts` order |
| 36 | 2026-09-29 | `baw` | High | `x402-payment sign` can send an on-chain Permit2 approval; neither `--help` nor the docs say so |
| 37 | 2026-09-29 | Agent Studio | High | The BNB Stock Agent rejects valid Agentic Wallet U payments with a bare `payment_rejected` |
| 38 | 2026-09-29 | x402 sellers | Medium | `PAYMENT-RESPONSE` has a different shape per seller; CoinMarketCap's carries no transaction hash |

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

## 22. Docs say `contract-call` takes no gas limit; the CLI has `--gasLimit`

- **Repro:** `baw contract-call preview --help` (v1.10.0) lists a `--gasLimit` option. The wallet docs (line 6295 of `llms-full.txt`) say: "**Do not pass gas settings.** `contract-call` accepts no gas limit, gas price or gas option."
- **Expected:** docs and CLI agree.
- **Actual:** the flag exists but is undocumented, and the docs forbid it. An integrator can't tell whether it is honored, ignored or reserved.
- **Suggested fix:** document `--gasLimit` (and when to use it), or remove it from the CLI.

## 23. `/swap` suggests a fixed 450,000 gas; a live swap used more

- **Repro:** our three live swaps on 2026-09-29 (receipts in `receipts/exec/`). `/swap` returned `tx.gas = "450000"` for every route, the same constant as `estimateGasFee` in `/quote` (#19).

  | Swap | `/swap` gas | Gas used | Wallet gas limit | `/swap` gas price | Price paid |
  |------|-------------|----------|------------------|-------------------|------------|
  | BNB to USDT (Lifi) | 450,000 | 367,670 | n/a | 0.060 gwei | n/a |
  | USDT to NVDAB (LiquidMesh, 2 hops) | 450,000 | **487,900** | 746,269 | 0.053 gwei | 0.069 gwei |
  | USDT to AAPLB (LiquidMesh, direct) | 450,000 | 358,376 | 548,900 | 0.053 gwei | 0.112 gwei |

- **Expected:** a per-route gas estimate that the transaction fits in.
- **Actual:** the NVDAB swap used 8% more than the suggested limit. A client that signs the `/swap` transaction as returned (or broadcasts it through `/pre-transaction/broadcast-transaction`) runs out of gas and pays for a revert. The Agentic Wallet re-estimates gas (limit about 1.5x usage) and prices it up to 2.1x the `/swap` gas price, so it was fine here.
- **Suggested fix:** estimate gas per route (the API already has `/pre-transaction/gas-limit`), or document that `tx.gas` is a placeholder that must be re-estimated.

## 24. Fresh LiquidMesh quotes fail their own 0.5% minimum in simulation

- **Repro:** `gap exec NVDAB --usd 1.5 --live` and `gap fund --bnb 0.0033 --live` at 15:24–15:26 UTC. Each run takes a fresh `/quote`, builds `/swap` with `slippagePercent=0.5`, then calls `/pre-transaction/simulate` for the wallet.
- **Expected:** a transaction built seconds after a quote passes simulation at 0.5% slippage on a $1.50 trade.
- **Actual:** three of six live attempts simulated as `FAILED: execution reverted: Min return not reached`. All three were LiquidMesh routes: one BNB to USDT, and two USDT to BTCB to USDC to WBNB to NVDAB (four hops for $1.50). A read-only probe that rebuilt the same NVDAB route at 3% slippage simulated fine, delivering only 0.14–0.27% below the quote, well inside 0.5%. The revert is probably a per-hop minimum inside the router, but the reason names no hop and no amounts. Within two minutes the aggregator picked other routes (Lifi for BNB to USDT; USDT to QQQB to NVDAB) and the same trades simulated and filled.
- **Impact:** a client that skips simulation pays gas for a revert. Our executor refuses before signing (`SIMULATION_FAILED`, receipts kept), which is why it simulates every transaction.
- **Suggested fix:** simulate the chosen route before returning it from `/quote`/`/swap`, prefer shorter routes at small sizes, and include the failing hop and amounts in the revert reason.

## 25. A Lifi fill landed 0.50% below its quote and simulation

- **Repro:** the live funding swap `0xe09f6292…` (receipt `2026-09-29T15-24-59-700Z-fund-BNBUSDT.json`): 0.0033 BNB to USDT through Lifi.
- **Expected:** a fill close to the quote and to a simulation run a few seconds earlier, as our LiquidMesh fills were (NVDAB 0.02% better than quoted, AAPLB 0.02% worse).
- **Actual:** quote 2.50441 USDT, simulation 2.50441 USDT, received 2.49193 USDT. That is 0.50% lower, and only 0.00004 USDT above the `minReceiveAmount` of 2.49189. It looks as if the whole slippage allowance was taken, but nothing in the quote, swap or transaction-detail response says who kept the difference.
- **Suggested fix:** document how positive and negative slippage is handled per vendor, and return the vendor fee and any surplus capture in `/swap` and in the transaction detail.

## 26. `/simulate` reverts are HTTP 200 with `status: FAILED`, and there is no response schema

- **Repro:** `POST /build/api/v1/dex/pre-transaction/simulate` with a swap from a wallet that holds no USDT (fixture `packages/core/test/fixtures/trade.json`, `usdtNvdab.simulate`).
- **Expected:** the response fields documented, including the status values and how a revert is reported.
- **Actual:** the docs (line 8377) describe the endpoint in one paragraph. A revert comes back as a successful API response (HTTP 200, no error code) with `data.status: "FAILED"` and `failReason: "execution reverted: BEP20: transfer amount exceeds balance"`. `balanceChanges[].change` is a signed base-unit string. None of this is written down, and a client that only checks `success` treats a revert as a pass.
- **Suggested fix:** publish the response schema (`status` enum, `failReason`, the sign and units of `change`, `allowanceChanges` shape) and say explicitly that `success` refers to the API call, not the transaction.

## 27. `/swap` response is undocumented

- **Repro:** any `GET /build/api/v1/dex/aggregator/swap` (fixture `trade.json`).
- **Actual:**
  - `tx.gas` is the gas limit, but `/simulate`, `/gas-limit` and `/broadcast-transaction` all take `evmTx.gasLimit`, so every client has to rename it.
  - `tx.gasPrice` and `tx.maxPriorityFeePerGas` are always equal, and it isn't said which one to use for a legacy or EIP-1559 transaction.
  - `tx.to`, the quote's `approveTarget` and `/approve-transaction`'s `dexContractAddress` were always the same router (`0xB444…DdA5`). That makes a useful safety check (approve exactly the contract you will call), but it isn't documented, so a client can't rely on it.
- **Suggested fix:** a field table for `/swap` like the request parameters have, and a statement that the spender to approve is `tx.to`.

## 28. `contract-call preview` returns token amounts as JSON numbers

- **Repro:** build a 0.0001 BNB to USDT swap with `/swap`, then run both `/pre-transaction/simulate` and `baw contract-call preview --binanceChainId 56 ... --json` on the same transaction (preview only, never executed). `/simulate` reports the USDT change as the string `"76119879871802694"`; the preview prints `"change": 76119879871802690`, an unquoted number already rounded by the CLI.
- **Expected:** 18-decimal token amounts as strings, like every Binance Web3 API response.
- **Actual:** any amount above 2^53 (about 0.009 of an 18-decimal token) is rounded before it reaches the client, so no JSON parser can recover it. The error is tiny, but a client comparing the preview with a minimum in base units can mismatch. Our executor checks amounts against `/simulate` and uses the preview only for its pass/fail and risk flags.
- **Suggested fix:** return amounts as decimal strings in the `--json` output.

## 29. `/quote` answers 40304 to US cloud regions, and the docs don't list it for trading

- **Repro:** deploy the web desk to Vercel with default settings (functions in `iad1`, Washington DC) and open `/api/check/MSTR`. Every venue's signed `GET /build/api/v1/dex/aggregator/quote` returns `40304 Service not available due to compliance restriction`. The same key, code and request from India (`bom1`, or a laptop) returns normal quotes.
- **Expected:** the trading docs to say which regions the aggregator refuses, and a specific code for "region not supported for tokenized stocks", like `40301`.
- **Actual:** `40304` is only listed under the DeFi endpoints (docs line 4305) as a catch-all "compliance rule not covered by a more specific code". Nothing in the trading or RWA sections says it can hit `/quote`, or that it depends on the server's region. A client that maps errors per venue shows every venue as untradeable, which is wrong: the venues are fine, the caller's region isn't. We pinned the functions to `bom1` and made the web desk report a region refusal as its own error, not as three BLOCKs.
- **Suggested fix:** list the IP compliance codes for the trading endpoints, name the affected regions for tokenized stocks, and use `40301` (region) for region blocks so clients can tell them apart from account or address compliance.

## 30. `market-order swap` executes at once, with no preview or dry run

- **Repro:** `baw market-order swap --binanceChainId 56 --fromToken <AAPLB> --toToken <USDT> --fromTokenQty 0.002857883746551181 --slippage 0.5 --mev true --gasLevel MEDIUM --json` (baw 1.10.0, 2026-09-29 17:05 UTC). It sold the position straight away.
- **Expected:** the same two-step flow as `contract-call` (`preview`, then `execute --requestId`), or at least a `--dry-run`.
- **Actual:** there is no preview, no confirmation and no simulation step. `market-order quote` is a separate call, so nothing ties the executed price to the quoted one: the swap can run at a different price than the quote you just checked, and only `--slippage` bounds it. An agent that calls `swap` to "see what happens" has traded. We run the gate and the wallet's own `market-order quote` first (within 0.5% of the gated quote, inside the CAUTION band vs the stock), then ask for a typed `yes`, then call `swap`.
- **Suggested fix:** add `market-order preview` returning a `requestId` bound to the quoted amounts, have `swap` accept it, and document that `swap` without it executes immediately.

## 31. `market-order swap` returns an `orderId` one lower than the stored order, and no status

- **Repro:** the swap above printed `{"orderId": "26092900001925734301"}`. `baw market-order list --orderId 26092900001925734301` returned an empty list; `baw market-order list --fromToken <AAPLB> --toToken <USDT>` showed the order as `26092900001925734302`, `status: "FINISHED"`, with its `txHash`. It happened again on the next sell: swap `…744435`, list `…744436` (receipts `receipts/exec/2026-09-29T17-05-48-637Z-exec-AAPLB.json` and `…17-11-17-799Z-exec-NVDAB.json`).
- **Expected:** the swap returns the id that `list --orderId` finds, plus an initial status.
- **Actual:** an agent polling by the returned id never sees its order and times out, even though it filled within seconds. Our first live sell was recorded as `PENDING / ORDER_TIMEOUT` for this reason. We now fall back to listing by pair from 2 minutes before the swap and matching `fromTokenQty`, keep the swap's id in the receipt as `swapResponseOrderId`, and added `gap reconcile` to settle an order after the fact from its transaction's `Transfer` logs. Both ids are 20-digit integers, which is also above 2^53 (see #28). The offset isn't fixed: a USDT to U conversion at 17:38 UTC returned `…798814` and was stored as `…798915`, 101 apart (receipt `receipts/exec/2026-09-29T17-38-50-503Z-fund-USDTU.json`), so a client can't simply add one.
- **Suggested fix:** return the stored order id as a string, with `status` and, once known, `txHash`.

## 32. `limit-order buy` on bStocks fails with "Raw limit orders are not supported. (2)"; undocumented

- **Repro:** `baw limit-order buy --binanceChainId 56 --fromToken <USDT> --toToken <AAPLB> --fromTokenQty 1 --triggerPrice 324.845557 --slippage 0.5 --json`, AAPLB GO at the time (2026-09-29 17:11 UTC, receipt `receipts/exec/2026-09-29T17-11-49-108Z-limit-AAPLB.json`). The wallet's market price was $331.34, so the trigger was 2% under it.
- **Expected:** a strategy id, or a documented reason why this token can't take limit orders.
- **Actual:** `success: false` with "Raw limit orders are not supported. (2)". The string is not in the CLI package, so it comes from the backend. Neither the wallet skill nor `baw limit-order buy --help` says which tokens support limit orders, and "Raw" isn't explained (most likely RWA, i.e. tokenized stocks). Nothing was placed. We couldn't check Ondo: at the $1 we could afford, the aggregator refuses AAPLon below its venue minimum (`40375`, see #11). Our executor now records a `success: false` answer from the wallet as `REFUSED / WALLET_REJECTED` (nothing placed), and keeps timeouts or unreadable replies as `FAILED`.
- **Suggested fix:** document which asset classes support limit orders, return a specific code for "limit orders not available for tokenized stocks", and expose it before placement (for example on the token in `wallet balance` or through a `limit-order quote`).

## 33. bStocks balances differ between `wallet balance`, `balanceOf` and `Transfer` amounts

- **Repro:** after buying AAPLB, `baw wallet balance` showed 0.0028596, `balanceOf` on the token contract returned 0.0028579, and the sell's `Transfer` log moved 0.0028562: about 0.06% apart at each step.
- **Expected:** one balance per token, or documentation of how the token's accounting scales.
- **Actual:** the three figures differ by a factor of about 1.0006 each. A sell sized from `wallet balance` asks for more than the wallet holds on chain. We size every sell from `balanceOf`, read the real amount sold from the `Transfer` log, and price per share from the `Transfer` amount. The fill then matches the quote to within 0.0001%.
- **Suggested fix:** have `wallet balance` report the on-chain `balanceOf`, and document the bStocks token's scaling (it looks like a rebasing or share-index token) so clients know which figure a transfer will use.

## 34. `x402-payment preview` marks a Permit2 option `READY_TO_SIGN` while `needApproveFirst` is true

- **Repro:** `baw x402-payment preview --paymentRequirements <PAYMENT-REQUIRED header of POST https://stock-agent.bnbchain.org/x402/analyze/async>` (baw 1.10.0, 2026-09-29), wallet holding USDT but no Permit2 allowance. Recorded in `packages/core/test/fixtures/x402.json`.
- **Expected:** an option that can't be paid yet is `ACTION_REQUIRED`, as U, USD1 and USDC are when the balance is short.
- **Actual:** USDT comes back `status: "READY_TO_SIGN"`, `reasons: []`, `needApproveFirst: true`. The campaign docs (line 7576 of `llms-full.txt`) tell agents to "select the READY_TO_SIGN option", and two lines later say USDC/USDT "require a one-time Permit2 allowance; without it set, the first payment fails". An agent following the docs picks USDT. We ignore `status` alone: an option is payable only if it is `READY_TO_SIGN` and `needApproveFirst` is false (or it is `eip3009`), and its `originalAccept` matches one of the server's `accepts` exactly.
- **Suggested fix:** return `ACTION_REQUIRED` with a reason such as `PERMIT2_ALLOWANCE_REQUIRED` while an approval is needed, or a separate `READY_AFTER_APPROVAL` status.

## 35. `x402-payment preview` indices are 1-based and reordered by balance

- **Repro:** the Stock Agent's 402 lists `accepts` as U, USD1, USDC, USDT. With only USDT in the wallet, the preview numbered them 1 USDT, 2 U, 3 USD1, 4 USDC. After converting 0.6 USDT to U, the same 402 previewed as 1 U, 2 USDT, 3 USD1, 4 USDC (receipts in `receipts/x402/`).
- **Expected:** the index is documented, and either it follows `accepts` or the docs say it doesn't.
- **Actual:** `--selectedIndex` is 1-based, while the rest of the payload is JSON arrays counted from 0. The order follows the wallet's balances, so it changes between previews. `--help` only says "index returned by x402-payment preview". A client that maps `accepts[i]` to `i` or `i + 1` signs the wrong token. We always sign with the `index` field of the option we picked from the same `paymentId`, and match that option's `originalAccept` against the server's `accepts`.
- **Suggested fix:** document that indices are 1-based and ranked, or accept the `originalAccept` (or its position in `accepts`) as the selector.

## 36. `x402-payment sign` can send an on-chain Permit2 approval; neither `--help` nor the docs say so

- **Repro:** read `baw x402-payment sign --help` (baw 1.10.0): "Sign a selected x402 payment option and return the replay header value". The CLI's own output code (`dist/index.js`) prints `approve txHash:` and `binanceChainId:` when the sign response has `approveTxHash`, so signing a Permit2 option can broadcast an approval transaction as a side effect.
- **Expected:** signing is off-chain. Any on-chain approval is a separate, explicit step with its own spender and amount shown, like `contract-call preview`.
- **Actual:** the only hint is the extra output fields. Nothing says which spender is approved, for how much, or that gas is spent. We didn't trigger it: the desk refuses any option that needs an approval, and if a sign response ever carries `approveTxHash` it records `FAILED / UNEXPECTED_APPROVAL` and doesn't replay the payment.
- **Suggested fix:** document the behaviour; better, return `ACTION_REQUIRED` from `sign` and add an explicit `x402-payment approve` that shows spender, amount and cost.

## 37. The BNB Stock Agent rejects valid Agentic Wallet U payments with a bare `payment_rejected`

- **Repro:** `POST https://stock-agent.bnbchain.org/x402/analyze/async` with `{"symbols":["NVDA"],"analysis_type":"comprehensive"}`, then `baw x402-payment preview` and `sign` on the U `eip3009` option (0.1 U; the wallet held 0.600159 U), then replay with `PAYMENT-SIGNATURE`. Four attempts, 17:39 to 17:48 UTC; receipts `receipts/x402/2026-09-29T17-39-30-667Z-x402-researchNVDA.json` and the three after it.
- **Expected:** `202 {jobId, jobToken}` and a settled payment, or a reason we can act on.
- **Actual:** every time, after about 13 s, `402 {"errorCode": "payment_rejected"}` with `PAYMENT-RESPONSE {success: false, transaction: "", payer: <our wallet>, errorReason: "payment_rejected"}`. Nothing was charged. The seller's public source ([`bnb-chain/stockanalyst-agent-demo`](https://github.com/bnb-chain/stockanalyst-agent-demo), `x402_verify.py` and `x402_job_service.py`) shows that answer comes after its own checks pass: `accepted` equal to its requirement, recipient, amount, window and EIP-712 recovery of our address. So B402's verify or settle refused, and the seller drops B402's `invalidReason`. What we ruled out: the U token's on-chain `DOMAIN_SEPARATOR` matches the "United Stables" v1 domain in the 402 and it has `transferWithAuthorization`; waiting 2–3 s past `validAfter` (baw sets it to the signing second, valid 120 s) changed nothing; lowercasing the authorization addresses changed nothing. Two minutes later the same wallet paid CoinMarketCap's x402 endpoint 0.01 U by `eip3009` and settled ([0xf397…d524](https://bscscan.com/tx/0xf3972ad59bf1ed815b241cb769f3df4f2e0cf3f1d1c3d54d73854a5b7f66d524)). So wallet signing works, and the refusal is on the Stock Agent's merchant or facilitator side.
- **Suggested fix:** pass B402's `invalidReason` or `errorReason` through in the 402 body (it isn't sensitive), and document merchant-side limits (daily budget, payer limits) on the price endpoint.

## 38. `PAYMENT-RESPONSE` has a different shape per seller; CoinMarketCap's carries no transaction hash

- **Repro:** compare the settlement headers in `receipts/x402/`. The Stock Agent sends `{success, transaction, network, payer, errorReason}` (x402 V2 `SettlementResponse`). CoinMarketCap (`https://mcp.coinmarketcap.com/x402/mcp`, `tools/call get_global_metrics_latest`, 17:50 UTC) sent `{x402Version, x402FlowId, resource: "X402_get_global_metrics_latest", status: "settled"}`.
- **Expected:** every B402 seller returns the V2 `SettlementResponse` with the transaction hash, so a buyer can prove what it paid.
- **Actual:** there's no `success` and no `transaction`. We read `status: "settled"` as success and found the settlement by scanning U `Transfer` logs from our wallet (0.01 U to `0x3C5f…3eeA` in [0xf397…d524](https://bscscan.com/tx/0xf3972ad59bf1ed815b241cb769f3df4f2e0cf3f1d1c3d54d73854a5b7f66d524)). That block is timestamped 17:50:52, after the `200` arrived at 17:50:51.6, so "settled" was sent before the transfer was mined. The data itself arrives as SSE, in `data:` → `result.content[0].text`, which holds a second JSON document.
- **Suggested fix:** require the standard `SettlementResponse` (with `transaction`) from B402 merchants, or have B402 expose a lookup by `x402FlowId`.
