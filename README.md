# Executable Gap Desk

**Displayed gaps lie. Executable ones don't.**

The same US stock trades on BNB Smart Chain as three different tokens: Ondo (`NVDAon`), xStocks (`NVDAx`) and bStocks (`NVDAB`). Their displayed prices can disagree by 10% or more, which looks like free money. Most of it isn't: the price is stale, the multiplier is wrong, or there is no liquidity to fill against.

Executable Gap Desk shows the displayed gap next to the executable one, gates every trade with a deterministic GO / CAUTION / BLOCK policy, and only then places small guarded fills through the Binance Agentic Wallet.

Built for **BNB Hack: Tokenized Stocks Edition** (BSC mainnet, spot only).

## Status

| Part | What | State |
|------|------|-------|
| 1 | Data truth: registry, session, per-share prices, displayed-gap matrix, CLI | done |
| 2 | Executable quotes and the GO / CAUTION / BLOCK gate | done |
| 3 | Guarded mainnet fills via `baw` with receipts | done |
| 4 | Web desk | next |
| 5 | Agentic Wallet and BNB Agent Studio integrations | planned |
| 6 | Ship: polish, demo, DX report | planned |

## Quickstart

Requires Node 24+ and pnpm 9.

```bash
pnpm i
pnpm gap matrix --multi          # every ticker listed on 2+ platforms, with displayed gaps and flags
pnpm gap matrix --ticker MSTR GME --sort gap
pnpm gap session                 # US session, countdown to the next open/close
pnpm gap resolve NVDA            # every BSC venue for a ticker, symbol or address
pnpm test                        # offline tests against recorded fixtures
```

No key is needed for the commands above. The executable-quote commands use the keyed Trading API: copy `.env.example` to `.env.local` (gitignored), fill in `BW3_API_KEY`, `BW3_API_SECRET` and optionally `GAP_WALLET_ADDRESS`, then:

```bash
pnpm gap ping                    # checks signing against the keyed API
pnpm gap check NVDA              # Truth Card: displayed vs executable per venue, verdict, best venue
pnpm gap check NVDA --ladder     # adds $100 and $500 quotes to measure price impact
pnpm gap quote AAPLon --usd 25 100 500
pnpm gap snapshot --all          # $25 sweep of every BSC tokenized stock (~75 s, rate-limited)
```

Example (2026-09-29, US regular session):

```text
MSTR   Ondo     MSTRon   $155.44   $155.77 ondo    -0.21%   TRADING
       bStocks  MSTRB    $155.47   $155.77 ondo    -0.19%   TRADING   no session
       xStocks  MSTRx    $138.86   $155.77 ondo   -10.86%   TRADING   LARGE GAP no session
```

MSTRx looks 11% cheap. Its price has not moved all day, and a $25 aggregator quote for it (like AAPLx and NVDAx) returns `40374 RWA_INSUFFICIENT_LIQUIDITY`. That is the trap this desk exists to catch.

### The Truth Card

`gap check` quotes $25 of USDT into every venue for a ticker and runs each quote through the gate:

```text
MSTR  stock $155.55 (ondo)   US regular session   size $25, quotes 0s old
│ Venue   │ Platform │ Displayed │ Disp. gap │ Executable │ Exec. gap │ Mode / vendor        │ Verdict │
│ MSTRon  │ Ondo     │   $155.78 │    +0.14% │        n/a │       n/a │ no liquidity (40374) │  BLOCK  │
│ MSTRB * │ bStocks  │   $155.94 │    +0.25% │    $155.97 │    +0.27% │ SWAP / LiquidMesh    │  GO     │
│ MSTRx   │ xStocks  │   $138.86 │   -10.73% │        n/a │       n/a │ no liquidity (40374) │  BLOCK  │
 BLOCK  MSTRx
   1. Quote failed: no liquidity from any vendor (40374).
Best venue: MSTRB (GO, +0.27% vs the stock, $155.97/share)
```

The 11% "discount" can't be bought. The only venue that fills does so at +0.27%.

The opposite trap is worse, because the displayed price looks fine. AAOIB displays within 0.2% of the stock, but the aggregator routes $25 through a thin Uniswap V4 pool and fills at **+397%** (API price impact 0.96). The gate blocks it for three reasons: the gap is too wide, displayed and executable disagree, and the fill is far above the displayed price. `gap quote MSFTon --usd 25` shows the extreme case: about $1 billion per share.

### Full sweep

`gap snapshot --all` (2026-09-29 14:39 UTC, regular session, $25 per venue) covered 117 tickers and 271 venues in 73 s:

| Verdict | Venues | Main reasons |
|---------|--------|--------------|
| GO | 134 | fill within 0.75% of the stock |
| CAUTION | 4 | fill 0.75–1.5% off |
| BLOCK | 133 | 106 quote with no liquidity (all 86 xStocks, 12 bStocks, 8 Ondo); about 25 thin-pool routes at +100% to +800% |

113 of the 117 tickers have at least one safe venue. Every successful quote came back as `SWAP` via LiquidMesh; see [DX log #16](docs/DX_LOG.md#16-docs-say-ondo-always-routes-via-rfq-live-quotes-are-all-swap).

### Gate policy

The gate is a pure function of the venue data, the quote, the session and [`packages/core/policy/default.json`](packages/core/policy/default.json), which is validated with zod. The worst rule wins:

| Rule | Threshold | Verdict |
|------|-----------|---------|
| No quote, quote error, or quote older than 60 s | | BLOCK |
| Trade size over the cap | $25 | BLOCK |
| Market or asset paused / not open | | BLOCK |
| Executable gap vs the stock | ≤ 0.75% GO, ≤ 1.5% CAUTION, else | BLOCK |
| No stock price to compare against | venues within 3% CAUTION, else | BLOCK |
| Displayed vs executable gap differ | > 3% | BLOCK |
| Fill vs displayed price per share | > 2% | BLOCK |
| Price impact from $25 to $100 (with `--ladder`) | > 1% | CAUTION |
| Outside US regular hours | | at best CAUTION |

The best venue is the cheapest GO, falling back to the cheapest CAUTION. A BLOCK venue is never recommended.

### Guarded execution

`gap exec` buys a venue with USDT, but only after the gate says GO and every transaction has been checked and simulated. It signs through the [Binance Agentic Wallet](https://web3.binance.com) CLI (`baw contract-call`), so no private key ever touches this repo. It needs `baw` installed and logged in, and `GAP_WALLET_ADDRESS` in `.env.local`.

```bash
pnpm gap exec NVDAB --usd 1.5            # dry run (the default): gate, build, simulate, write a receipt
pnpm gap exec NVDAB --usd 1.5 --live     # same, then asks you to type "yes" before each signature
pnpm gap fund --bnb 0.0033               # one-off BNB -> USDT conversion through the same checks
pnpm gap receipts                        # the ledger of every run, plus today's live spend
```

Every run writes a JSON receipt to [`receipts/exec/`](receipts/exec/), including refusals. A refusal happens before anything is signed and exits non-zero. The rails, in order:

1. **Kill switch and dry run:** `GAP_EXEC_DISABLED=1` refuses everything; nothing is broadcast without `--live`; `DRY_RUN=1` overrides `--live`; `--yes` only works together with `--live`.
2. **Size:** at most $25 per trade (policy `maxTradeUsd`) and $5 per UTC day across live fills (`maxDailySpendUsd`, summed from the receipts).
3. **Gate:** the venue must be GO on a quote at most 60 s old. CAUTION and BLOCK are refused, so off-hours trading is refused by design. RFQ routes are refused (`MODE_RFQ_UNSUPPORTED`) until that signing path is tested.
4. **Approval:** exact amount only, never unlimited. The spender in the approve calldata must be the quote's `approveTarget`. The allowance is re-read on-chain after the approval confirms.
5. **Transaction checks:** re-quote and re-gate, then build with 0.5% slippage (`slippagePct`). `tx.from` must be the wallet, `tx.to` the approved router, `tx.value` exactly what is being sold. At the guaranteed minimum output the fill must still be inside the CAUTION band vs the stock.
6. **Simulation:** Binance `/pre-transaction/simulate` must succeed and deliver at least the minimum. A dry run from an unfunded wallet falls back to a BSC `eth_call` with the USDT balance and allowance overridden, and the receipt says which one ran.
7. **Wallet preview:** `baw contract-call preview` must pass its own simulation with no risk flags, and then you confirm.
8. **After broadcast:** wait for the receipt (a revert is recorded as `TX_REVERTED`), then read the real fill from the `Transfer` logs and compare it with the quote.

## How it works

```mermaid
flowchart LR
  listApi[RWA list] --> registry
  statusApi[RWA market status] --> session
  dynApi[RWA dynamic v2] --> prices
  registry --> matrix
  prices --> matrix
  session --> matrix
  matrix --> cli[gap CLI]
  quoteApi[Keyed /quote] --> quotes
  matrix --> gate[Gate]
  quotes --> gate
  gate --> cli
  gate --> exec[Executor]
  swapApi[Keyed /approve, /swap, /simulate] --> exec
  exec --> baw[Agentic Wallet baw]
  baw --> bsc[BSC mainnet]
  bsc --> exec
  exec --> receipts[receipts/exec]
```

- **Registry** (`packages/core/src/registry.ts`): BSC venues from the public RWA list, platform by `type` (1 Ondo, 2 xStocks, 3 bStocks), grouped by ticker.
- **Session** (`session.ts`): market status normalized to premarket / regular / postmarket / overnight / closed / pause / weekend, with correctly ordered next open and close.
- **Prices** (`prices.ts`): `perShare = tokenPrice / sharesMultiplier`, using the live multiplier from dynamic v2. The reference is the underlying stock price (Ondo first, then xStocks), never a venue's own token price.
- **Matrix** (`matrix.ts`): displayed gap per venue with flags `LARGE_DISPLAYED_GAP` (3%+), `NO_PRICE`, `NO_REFERENCE`, `MULTIPLIER_MISMATCH`, `STATUS_MISSING` and `API_ERROR`. One failing venue never fails the matrix.
- **Signer** (`signer.ts`): HMAC-SHA256 request signing for the keyed Web3 API (`/build` prefix included in the signed path). A 429 or 5xx response is re-signed with a fresh timestamp before retrying.
- **Quotes** (`quotes.ts`): USDT to token quotes at $25, $100 and $500. `fillPerShare = usd / (tokensOut × multiplier)`, `executableGap = fillPerShare / stock − 1`. Error codes map to plain-English reasons. Requests are spaced at 4.5 per second to stay under the 5 RPS endpoint limit.
- **Gate** (`gate.ts`): deterministic GO / CAUTION / BLOCK per venue with numbered reasons, plus the best venue per ticker.
- **Snapshot** (`snapshot.ts`): the rate-limited sweep behind `gap snapshot`, cached for 60 s.
- **Trade API** (`trade.ts`): keyed `/approve-transaction`, `/swap`, `/pre-transaction/simulate` and transaction detail, with zod schemas taken from recorded responses.
- **Chain** (`chain.ts`): viem reads on BSC (balances, allowance, receipts, `Transfer` logs), approve-calldata decoding, and the state-override `eth_call` used for unfunded dry runs.
- **Wallet** (`baw.ts`): runs `baw contract-call preview/execute` without a shell and parses its JSON (including after its Windows exit crash, DX #13).
- **Executor** (`execute.ts`): the rails above, `PENDING_CONFIRMATION` polling, and receipts.

```text
packages/core/     data layer (config, http, schemas, registry, session, prices, matrix, signer, quotes, gate, snapshot)
                   + execution (trade, chain, baw, execute) + tests
packages/core/policy/  gate policy (JSON, zod-validated)
apps/agent/        gap CLI
scripts/           fixture recorder
receipts/exec/     one JSON receipt per gap exec / gap fund run (fills and refusals)
docs/DX_LOG.md     developer-experience findings
docs/vendor/       snapshot of the Binance Web3 llms-full.txt docs
```

## Proof ledger

Real BSC mainnet runs of `gap exec` / `gap fund` on 2026-09-29, from the Agentic Wallet [`0x623d…1C65`](https://bscscan.com/address/0x623dF829DF5cf33506a0fbb152dbc885d5b61C65). Every row has a JSON receipt in [`receipts/exec/`](receipts/exec/).

**Fills**

| Run (UTC) | What | Size | Gate | Quoted | Filled | Fill vs quote | Fill vs stock | Tx |
|------------|------|------|------|--------|--------|---------------|---------------|----|
| 15:25:00 | Fund: BNB to USDT (Lifi) | 0.0033 BNB ($2.49) | n/a (buys no stock) | 2.5044 USDT | 2.4919 USDT | -0.50% ([DX #25](docs/DX_LOG.md#25-a-lifi-fill-landed-050-below-its-quote-and-simulation)) | n/a | [0xe09f…2f34](https://bscscan.com/tx/0xe09f6292637ddb7475be64399f5fcc3db2604f3296382d336e804648bd972f34) |
| 15:25:13 | Approve exactly 1.5 USDT to the router | 1.5 USDT | GO | | | | | [0x4666…156e](https://bscscan.com/tx/0x4666b56de77cdc180beb92c5ae4d01d2dca1809063ff3eef6f3dc48c32e8156e) |
| 15:27:02 | **Buy NVDAB** (USDT to QQQB to NVDAB) | $1.50 | GO | $229.83/share | **$229.79/share** (0.00652272 NVDAB) | -0.02% (better) | -0.11% | [0x5072…0a82](https://bscscan.com/tx/0x5072d691dd8555ef9a1527aaa4eb10946d148b32d37a4ab9b4bb0b76137f0a82) |
| 15:31:55 | Approve exactly 0.95 USDT to the router | 0.95 USDT | GO | | | | | [0x902c…5586](https://bscscan.com/tx/0x902c99b3efe83dcc9daec2058768c8dda8f3cb17168fd929c80a135d9f595586) |
| 15:31:55 | **Buy AAPLB** (USDT to AAPLB) | $0.95 | GO | $332.14/share | **$332.21/share** (0.00285788 AAPLB) | +0.02% | +0.11% | [0x6327…d41f](https://bscscan.com/tx/0x63272d01cda4a3fa03f48e64a0bd8f9fa2716c1c69aadf122e95db37692cd41f) |

Both stock fills landed within 0.02% of the quote and 0.11% of the stock. Network fees were about 0.00003 BNB (under $0.03) per swap. Both exact approvals were fully used: the router's USDT allowance is back to 0.

**Refusals (nothing signed)**

| Run (UTC) | Venue | Size | Mode | Refused because |
|------------|-------|------|------|-----------------|
| 15:20:08 | MSTRx | $1 | dry run | Gate BLOCK: displays 9.7% below the stock, but the quote returns no liquidity (`40374`) |
| 15:20:12 | AAOIB | $1 | dry run | Gate BLOCK: displays -0.49% vs the stock but would fill at **+389%** ($500.97 per share for a $102.43 stock) |
| 15:24:43 | BNB to USDT | 0.0033 BNB | live | Binance simulation reverted: "Min return not reached" on a fresh LiquidMesh quote ([DX #24](docs/DX_LOG.md#24-fresh-liquidmesh-quotes-fail-their-own-05-minimum-in-simulation)) |
| 15:25:13 | NVDAB | $1.50 | live | Same: a four-hop LiquidMesh route (USDT, BTCB, USDC, WBNB, NVDAB) failed its own 0.5% minimum. The exact approval had gone through; the swap never did |
| 15:25:31 | NVDAB | $1.50 | live | Same route, same simulated revert |

## Developer experience

We keep a running log of every rough edge we hit in the Binance Web3 APIs, the Skills Hub and the Agentic Wallet CLI, each with a reproduction and a suggested fix: [`docs/DX_LOG.md`](docs/DX_LOG.md) (28 entries so far; #22–#28 come from the live fills).

_The full DX report will be summarized here in Part 6._

## License

[MIT](LICENSE)
