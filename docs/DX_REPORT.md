# DX report: Executable Gap Desk

Developer-experience report for **BNB Hack: Tokenized Stocks Edition**, laid out in the same order as the [DX form](https://forms.gle/EUQ39xf54GHjC2ys5) so each answer can be pasted into its field. Every issue cited as "DX #n" has a reproduction, expected vs actual behaviour and a suggested fix in [`DX_LOG.md`](DX_LOG.md) (42 entries: 15 High, 21 Medium, 6 Low), also browsable on the [DX page](https://executable-gap-desk.vercel.app/dx). All of it was hit on BSC mainnet on 2026-09-29, with receipts in [`receipts/`](../receipts/).

Lines marked **[fill in]** are facts only the team can give.

## Top issues at a glance

The ten that cost us the most, or would hurt other builders most:

| DX | Area | What goes wrong | Suggested fix |
|----|------|-----------------|---------------|
| #1 | Docs | `llms.txt` / `llms-full.txt` answer AI agents with an empty 202 WAF challenge | Exempt `/dev-docs/llms*.txt` from the WAF, or mirror them statically |
| #7 | RWA API | xStocks prices are stale with no timestamp (MSTRx −10.9%, GMEx +894% vs the stock) | Add `priceUpdatedAt` and `priceSource`; null out stale prices |
| #17 | Trading API | `/quote` returns `success: true` for 88–99.95% price-impact routes (MSFTon at ~$1B per share) | A `warnings` array on `/quote`, and the `/swap` 90% guard applied at quote time |
| #24 | Trading API | Fresh LiquidMesh quotes fail their own 0.5% minimum in simulation ("Min return not reached") | Simulate the chosen route before returning it; name the failing hop |
| #16 | Trading docs | Docs say Ondo always routes via RFQ; all 165 live quotes were `SWAP` via LiquidMesh | Document when RFQ is actually offered |
| #30 | `baw` | `market-order swap` executes immediately: no preview, no dry run, nothing binds it to the quote | `market-order preview` returning a `requestId` that `swap` accepts |
| #31 | `baw` | `market-order swap` returns an order id that `list --orderId` can't find (off by 1, once by 101) | Return the stored id as a string, with status and txHash |
| #34 | `baw` | `x402-payment preview` marks a Permit2 option `READY_TO_SIGN` while it still needs an approval | `ACTION_REQUIRED` with `PERMIT2_ALLOWANCE_REQUIRED` |
| #37 | Agent Studio | The BNB Stock Agent rejects valid Agentic Wallet U payments with a bare `payment_rejected` | Pass B402's `invalidReason` through; align its B402 client with the `000000000` success code (#39) |
| #41 | `baw` | `wallet send` only reaches address-book recipients; `--help` doesn't say so and no CLI command can add one | State it in `--help`; add `address-book list` and an add flow confirmed in the app |

---

## 1. Submission details

- **Team or project name:** Executable Gap Desk
- **Contact email:** [fill in]
- **Public repository URL:** https://github.com/Assassin859/executable-gap-desk
- **Binance Web3 API modules and tools used:**
  - Public RWA endpoints: stock list, dynamic v2, market status, asset market status.
  - Keyed Trading API: aggregator `/quote`, `/swap`, `/approve-transaction`, pre-transaction `/simulate`, transaction detail.
  - Keyed Market API: `rwa/platforms`.
  - B402 (`/supported`, `/verify`, `/settle`) as an x402 seller.
  - Agentic Wallet CLI `baw` 1.10.0: `contract-call`, `wallet balance`/`send`, `market-order`, `limit-order`, `x402-payment`.
  - Binance Skills Hub: the tokenized-securities and Agentic Wallet skills.
  - BNB Agent Studio CLI `bag` 0.0.14.
  - ERC-8004 IdentityRegistry on BSC mainnet (agent 360456).
  - The U stablecoin (EIP-3009) for x402.
- **Team size:** [fill in]
- **Most experienced member's time building on Web3:** [fill in]
- **Used the Binance Web3 API before the hackathon:** [fill in]

## 2. Onboarding

- **Time from opening the docs to the first successful API call:** [fill in]. The public RWA endpoints worked the same day, once we found they need `User-Agent: binance-web3/1.1 (Skill)` and `Accept-Encoding: identity`.
- **Time to a working API key:** [fill in]. B402 needed a separate onboarding with a write-once `payTo`.
- **Onboarding rating:** [fill in]
- **Where we got stuck:**
  - The docs meant for agents (`llms-full.txt`) returned an empty WAF challenge to our coding agent (DX #1), so we had to fetch them in a browser and vendor a copy.
  - The skill told us Ondo was the only provider, while the API returns five platform types (DX #2).
- **What took longer than expected:**
  - Reverse-engineering the `/quote` and `/swap` responses. There is no response schema (DX #20, #27). `priceImpactPercent` is a fraction (DX #18), and `tradeFee` / `estimateGasFee` are a network fee and a gas limit (DX #19).
  - Deploying the web desk: from US cloud regions `/quote` answered `40304`, and the trading docs don't list that code (DX #29). We had to pin the functions to Mumbai (`bom1`).
- **Did we feed llms.txt / llms-full.txt to an AI agent:** yes, a vendored copy ([`docs/vendor/llms-full.txt`](vendor/llms-full.txt)), because the live URL is behind a WAF challenge (DX #1).
- **What the AI agent got wrong against the docs:** it believed the docs where the live API disagrees:
  - It expected Ondo quotes to be RFQ (DX #16).
  - It treated `priceImpactPercent` as a percent (DX #18).
  - It avoided `--gasLimit` because the docs forbid it, though the CLI has it (DX #22).
  - It picked the `READY_TO_SIGN` USDT option, as the campaign docs say to, though that option still needed a Permit2 approval (DX #34).

## 3. Documentation issues

- **Documentation rating:** [fill in]
- **Documentation errors found:**
  - Ondo is "always routed via 3-vendor RFQ" (all live quotes were SWAP; DX #16).
  - `40374` is filed only under Ondo/BStock RFQ errors, but it is what every xStock returns (DX #8).
  - "`contract-call` accepts no gas limit" (the CLI has `--gasLimit`; DX #22).
  - The skill says Ondo is the only provider (DX #2).
  - The wallet skill still ships a campaign file that expired on 2026-09-01 (DX #6).
  - `priceImpactPercent` is named as a percent but is a 0–1 fraction (DX #18).
  - The Ondo minimum is $5 via `baw` but $20 via RFQ (DX #11).
- **Missing or under-documented topics:**
  - Response schemas for `/quote`, `/swap` and `/simulate` (DX #20, #26, #27).
  - The rate-limit window type (DX #21).
  - Which regions the trading API refuses (DX #29).
  - A market-session endpoint in the keyed docs (DX #10).
  - Which tokens support wallet limit orders (DX #32).
  - That `x402-payment sign` can broadcast a Permit2 approval (DX #36).
  - That `wallet send` needs an address-book entry (DX #41).
  - The meaning of the market-status `nextOpen` / `nextClose` pair (DX #4).
  - The bStocks balance scaling (DX #33).
- **Were the code examples runnable as written:** partly. The curl examples for the public endpoints run only with the two headers above. The `baw` examples run.
- **Which examples failed and what we changed:**
  - We added the `User-Agent` and `Accept-Encoding` headers to the public calls.
  - We included the `/build` prefix in the signed path for keyed calls.
  - We paced requests evenly at 4.5 RPS instead of a 5-token burst (DX #21).
  - We re-estimated gas instead of using `/swap`'s fixed `tx.gas` of 450,000, which a live swap exceeded (DX #23).
- **Most useful page:** the aggregator trading guide (quote, approve, swap, simulate). The RWA error-code table was the most used reference once we knew `40374` applies to xStocks too.

## 4. API pitfalls

- **Reliability and stability rating:** [fill in]. The endpoints were up throughout; the problems were in data and semantics, not uptime.
- **Edge cases and unexpected behaviour:**
  - Near-total-loss routes quoted as successful (DX #17).
  - Fresh quotes that revert in simulation (DX #24).
  - A Lifi fill that took the full 0.5% slippage allowance (DX #25).
  - `/simulate` reverts come back as HTTP 200 `status: FAILED` (DX #26).
  - `contract-call preview` rounds token amounts above 2^53 (DX #28).
  - Market-order ids that don't match (DX #31).
  - Limit orders rejected for bStocks (DX #32).
  - Three different balances for the same bStocks position (DX #33).
  - x402 option indices that are 1-based and reordered by wallet balance (DX #35).
- **Unclear or misleading error messages:**
  - "Raw limit orders are not supported. (2)" (DX #32).
  - "Min return not reached" with no hop or amounts (DX #24).
  - A raw `({0})` placeholder in the Ondo pair error (DX #12).
  - `40304` "compliance restriction" for what is a server-region block (DX #29).
  - The Stock Agent's bare `payment_rejected` (DX #37).
- **Slow endpoints:** none were a problem. A live three-venue check takes about 3 s, B402 Verify answered in about 0.2 s, and a B402 settlement was mined about 6 s after the paid request. The slowest step was the Stock Agent taking about 13 s to reject a payment.
- **Rate limits:** yes, once: `42900` during the first full sweep (DX #21).
- **What we were doing and how the API responded:** quoting all 666 BSC venues with a token bucket of 5 RPS and a burst of 5. That puts up to 9 requests in one second, and one got `42900`. Even pacing at 4.5 RPS with no burst finished the sweep with zero 429s.
- **Authentication and signing:**
  - The HMAC signature must cover the path including `/build`.
  - B402 calls sign the exact raw body inside a `{"body": ...}` envelope, and answer success as `000000000`, a third success code and envelope shape in the same product family (DX #39).
  - Nothing failed once these were known, but none of it is obvious.
- **Data we couldn't trust or reconcile:**
  - Stale xStocks prices (DX #7).
  - `sharesMultiplier = 1` for every xStock in the list endpoint, while dynamic v2 has the real values (DX #15).
  - `volume24h` is the underlying stock's volume, not the token's (DX #5).
  - Nulls in dynamic v2 for xStocks and bStocks (DX #3).
  - `dividendYield` in different units per platform (DX #14).
  - bStocks balances that differ between the wallet, `balanceOf` and `Transfer` logs (DX #33).
  - CoinMarketCap's `PAYMENT-RESPONSE` said "settled" before the transfer was mined, with no tx hash (DX #38).

## 5. AI stack feedback

- **Parts used:**
  - Cursor agent mode for the whole build ([fill in]: models used).
  - Binance Skills Hub skills as agent context.
  - The Agentic Wallet (`baw`) as the only signer: trades, market orders, x402 payments and the ERC-8004 registration.
  - BNB Agent Studio (`bag`) for an A2A / MCP / x402 agent.
  - Our own MCP server over the gate, for Cursor.
- **AI execution layer rating:** [fill in]
- **What worked well:**
  - Keys never leave the wallet.
  - `contract-call preview` then `execute` gives a real simulation step with risk flags before anything is signed.
  - `x402-payment preview/sign` made paying an x402 seller a two-command flow; CoinMarketCap's paid endpoint settled 0.01 U on mainnet.
  - B402 as a facilitator is clean: `/supported` gives the requirements, Verify and Settle are fast, and it pays the settlement gas. Our first sale settled on mainnet with no extra infrastructure.
- **What did not work:**
  - `market-order swap` has no preview, so an agent that "just checks" has traded (DX #30).
  - Order ids that the list command can't find (DX #31).
  - `x402-payment preview` status that misleads agents (DX #34).
  - `sign` can send an approval transaction without saying so (DX #36).
  - An address book that blocks agent-to-agent funding (DX #41).
  - On Windows, `baw` crashes with a libuv assertion after error responses (DX #13).
- **What is missing:**
  - A dry-run or preview for every state-changing `baw` command.
  - Machine-readable error codes instead of free text.
  - A way for an agent to request an address-book entry that the user confirms in the app.
  - Order status in the swap response.
  - A documented list of which assets support which order types.
- **How BNB Agent Studio held up:**
  - Good: `bag init` gave a working A2A + MCP + x402 agent in minutes; `bag doctor` is thorough; `bag dev` served all three faces locally.
  - Friction:
    - The `bag dev` banner lists skills and pricing the agent doesn't have (DX #42).
    - The official BNB Stock Agent demo rejected our valid payments (DX #37). B402 accepted the same kind of proof from us in a verify-only test, so the refusal is in the demo's merchant path.

## 6. Tokenized-stock specifics

- **Platforms:** Ondo (`…on`), xStocks (`…x`) and bStocks (`…B`) on BSC.
- **Liquidity depth:** a $25 quote into every venue (666 venues, 512 tickers):
  - 454 GO, 14 CAUTION, 198 BLOCK.
  - 165 venues had no liquidity at all (`40374`), including **all 128 xStocks**, 23 Ondo and 14 bStocks.
  - Another 33 routes filled but failed the gate, 21 of them at +100% or worse through thin pools.
  - 442 of 512 tickers have at least one venue within 0.75% of the stock at $25.
- **Slippage at our sizes ($0.95–$2.50):**
  - The LiquidMesh fills landed within 0.02% of the quote.
  - Wallet market-order sells matched the gated quote to 0.0001%.
  - One Lifi funding swap landed 0.50% under its quote, at the minimum (DX #25).
  - Three of six fresh LiquidMesh quotes reverted in simulation at 0.5% slippage (DX #24).
- **Outside market hours:**
  - The session feed has a two-minute break between regular and after-hours, and `nextClose` comes before `nextOpen` (DX #4).
  - bStocks and xStocks publish no session status (DX #3), so we use the US session for them.
  - After 20:00 UTC the same NVDAB, AAPLB and NVDAon trades quoted within 0.06% of the stock. Our gate still refuses them off-hours by design (receipts in `receipts/exec/`).
  - Wallet limit orders were rejected for bStocks (DX #32).
- **Gaps between on-chain price and the reference:**
  - Displayed gaps are often fiction. MSTRx displayed −10.9% for hours without moving (stale; DX #7) and can't be bought (`40374`).
  - GMEx displays +894%, which looks like a missed corporate action.
  - The reverse trap: AAOIB displays within 0.2% of the stock but a $25 order fills at +397%, and MSFTon's route implies about $1B per share (DX #17).
  - Executable gaps on liquid venues are small: 454 venues filled a $25 order within 0.75% of the stock.
- **Differences between representations of the same ticker:**
  - Per-share pricing needs the live `sharesMultiplier` from dynamic v2; the list says 1 for every xStock (DX #15).
  - Only Ondo returns session, holders and a stock price (DX #3).
  - `dividendYield` units differ (DX #14).
  - bStocks token balances scale by about 0.06% between readings (DX #33).
  - Ondo and bStocks quote as SWAP via LiquidMesh despite the RFQ docs (DX #16).
  - xStocks don't quote at all at $25.
  - The keyed `rwa/platforms` endpoint omits xStocks (DX #9).

## 7. Redesign suggestions and requested capabilities

- **How we would redesign onboarding so a call works immediately:**
  - Serve `llms-full.txt` and the Markdown docs without a WAF challenge.
  - Put a copy-paste curl for a public endpoint on the landing page, with the required headers included.
  - Give an in-browser "try it" for keyed endpoints that signs with a test key.
  - Publish an OpenAPI spec for the response bodies, so clients and agents can generate typed code instead of guessing units.
- **Endpoints, SDKs and tooling we want:**
  - A typed TypeScript SDK for the aggregator and pre-transaction APIs.
  - `priceUpdatedAt` on RWA prices, and a per-venue session in dynamic v2.
  - A `warnings` field (price impact, stale price, route length) on `/quote`.
  - A keyed market-session endpoint.
  - For `baw`:
    - `market-order preview`;
    - order status in `swap` responses;
    - `address-book list/add`;
    - string amounts in all JSON;
    - stable error codes.
  - `asset` and `decimals` in B402 `/supported` (DX #40).
- **The one change that would have saved the most time:** response schemas with units for `/quote`, `/swap` and `/simulate`. About a third of our DX entries came from guessing what a field means.
- **Will we keep building on the Binance Web3 API:** [fill in]
- **Why:** [fill in]
- **Anything else:** the stack has everything needed for an agent that can prove its trades are real: RWA data, the aggregator, simulation, a wallet that never exposes keys, x402 in both directions, and on-chain identity. The gaps are in truthfulness signals (stale prices, silent near-total-loss routes) and in agent-safety affordances (preview before every state change, machine-readable errors). Executable Gap Desk exists because the displayed price and the executable price disagree, and an agent can't tell which one to trust from the API alone.
