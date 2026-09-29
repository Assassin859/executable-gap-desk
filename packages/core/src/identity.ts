import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeFunctionData, parseAbi, parseEventLogs, type Address, type Hex, type Log, type TransactionReceipt } from "viem";
import { z } from "zod";
import { createBawRunner, executeContractCall, findTxSince, previewContractCall, type ContractCall, type ContractCallPreview, type ContractCallResult } from "./baw";
import { bscClient, bscTxUrl } from "./chain";
import { Refusal, commonRails, lower, units, type ExecMode, type RefusalCode } from "./execute";

/** ERC-8004 registries on BSC mainnet (bnb-chain/erc-8004-contracts). */
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
export const AGENT_REGISTRY_ID = `eip155:56:${IDENTITY_REGISTRY}`;
export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
export const DEFAULT_AGENT_URI = "https://executable-gap-desk.vercel.app/.well-known/agent-card.json";

export const identityRegistryAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export const AgentCardSchema = z.looseObject({
  type: z.literal(REGISTRATION_TYPE),
  name: z.string().min(1),
  description: z.string().min(1),
  image: z.string().regex(/^https:\/\//),
  services: z.array(z.looseObject({ name: z.string().min(1), endpoint: z.string().min(1), version: z.string().optional() })).min(1),
  x402Support: z.boolean().optional(),
  active: z.boolean().optional(),
  registrations: z.array(
    z.looseObject({
      agentId: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
      agentRegistry: z.string().regex(/^eip155:\d+:0x[0-9a-fA-F]{40}$/),
    }),
  ),
  supportedTrust: z.array(z.string()).optional(),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

export const registerCalldata = (agentURI: string): Hex => encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [agentURI] });

/** The `Registered` event emitted by the registry itself (a look-alike from another contract is ignored). */
export function parseRegistered(logs: Log[], registry: string = IDENTITY_REGISTRY): { agentId: bigint; agentURI: string; owner: string } | null {
  const hit = parseEventLogs({ abi: identityRegistryAbi, eventName: "Registered", logs, strict: true }).find((l) => lower(l.address) === lower(registry));
  return hit ? { agentId: hit.args.agentId, agentURI: hit.args.agentURI, owner: hit.args.owner } : null;
}

/** An https URI on a public host; the card itself is checked separately. */
export function checkAgentUri(uri: string): URL {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new Refusal("BAD_AGENT_URI", `Not a URL: ${uri}`);
  }
  if (u.protocol !== "https:") throw new Refusal("BAD_AGENT_URI", `The agent URI must be https, got ${u.protocol}`);
  if (/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[)/.test(u.hostname) || u.hostname.endsWith(".local")) {
    throw new Refusal("BAD_AGENT_URI", `The agent URI must be publicly reachable, got ${u.hostname}`);
  }
  return u;
}

export function parseAgentCard(json: unknown): AgentCard {
  const p = AgentCardSchema.safeParse(json);
  if (!p.success) throw new Refusal("BAD_AGENT_CARD", `The agent card is not an ERC-8004 registration-v1 file: ${p.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
  return p.data;
}

/** Registrations in the card that point at this registry. */
export const cardRegistrationsFor = (card: AgentCard, registry: string = AGENT_REGISTRY_ID) =>
  card.registrations.filter((r) => lower(r.agentRegistry) === lower(registry)).map((r) => BigInt(r.agentId));

// ---------- the registration receipt ----------

export type IdentityOutcome = "REGISTERED" | "SIMULATED" | "REFUSED" | "FAILED" | "PENDING";

export interface IdentityRecord {
  version: 1;
  kind: "erc8004-identity";
  createdAt: string;
  mode: ExecMode;
  outcome: IdentityOutcome;
  refusal: { code: RefusalCode | "ERROR"; message: string } | null;
  registry: string;
  agentRegistry: string;
  agentURI: string;
  wallet: string;
  agentId: string | null;
  card: { name: string; services: string[] } | null;
  gas: { estimate: string; gasPriceWei: string; feeWei: string; feeBnb: number; balanceWei: string; requiredWei: string } | null;
  tx: {
    to: string;
    value: string;
    data: string;
    preview?: { requestId: string; requireConfirmation: boolean; simulationOk: boolean; risks: unknown[] };
    broadcastStatus?: string;
    txHash?: string;
    bscscan?: string;
    blockNumber?: string;
    gasUsed?: string;
    gasCostBnb?: number;
  } | null;
  steps: Array<{ at: string; step: string; detail?: string }>;
}

export function readIdentityRecord(path: string): IdentityRecord | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as IdentityRecord) : null;
}

function writeJson(path: string, v: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2)}\n`);
  return path;
}

// ---------- deps ----------

export interface IdentityDeps {
  chain: {
    balance(owner: string): Promise<bigint>;
    agentCount(owner: string): Promise<bigint>;
    estimateGas(from: string, to: string, data: string): Promise<bigint>;
    gasPrice(): Promise<bigint>;
    waitForReceipt(hash: string): Promise<TransactionReceipt>;
    tokenURI(agentId: bigint): Promise<string>;
    ownerOf(agentId: bigint): Promise<string>;
  };
  fetchJson(url: string): Promise<unknown>;
  baw: {
    preview(c: ContractCall): Promise<ContractCallPreview>;
    execute(requestId: string): Promise<ContractCallResult>;
    findTxSince(sinceMs: number, to: string): Promise<string | null>;
  };
  confirm(summary: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(step: string, detail?: string): void;
}

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "follow" });
  if (!res.ok) throw new Refusal("BAD_AGENT_URI", `${url} answered HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new Refusal("BAD_AGENT_CARD", `${url} is not JSON.`);
  }
}

export function defaultIdentityDeps(): IdentityDeps {
  const client = bscClient();
  const run = createBawRunner();
  const registry = IDENTITY_REGISTRY as Address;
  return {
    chain: {
      balance: (owner) => client.getBalance({ address: owner as Address }),
      agentCount: (owner) => client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "balanceOf", args: [owner as Address] }),
      estimateGas: (from, to, data) => client.estimateGas({ account: from as Address, to: to as Address, data: data as Hex }),
      gasPrice: () => client.getGasPrice(),
      waitForReceipt: (hash) => client.waitForTransactionReceipt({ hash: hash as Hex, timeout: 120_000, pollingInterval: 1_500 }),
      tokenURI: (id) => client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "tokenURI", args: [id] }),
      ownerOf: (id) => client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [id] }),
    },
    fetchJson,
    baw: {
      preview: (c) => previewContractCall(c, run),
      execute: (id) => executeContractCall(id, run),
      findTxSince: (since, to) => findTxSince(since, to, run),
    },
    confirm: async () => false,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
  };
}

// ---------- register ----------

/** Fee-based gas rail for this one call: the balance must cover 5x the estimated fee. */
export const IDENTITY_FEE_MULTIPLE = 5n;
/** Headroom on the node's gas estimate; the rail and the summary use the padded figure. */
const GAS_PAD_PCT = 120n;
const PENDING_POLL_MS = 5_000;
const PENDING_TIMEOUT_MS = 5 * 60_000;

export interface RegisterOptions {
  uri?: string;
  live?: boolean;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<IdentityDeps>;
  /** `receipts/identity.json`; null in tests. Its presence with an agentId or a tx blocks a second registration. */
  recordPath: string | null;
  /** Every attempt (dry runs and refusals too) is also written here. */
  attemptsDir?: string | null;
}

export interface RegisterResult {
  record: IdentityRecord;
  path: string | null;
}

/**
 * Registers the Agentic Wallet as an ERC-8004 agent pointing at the agent card. Rails: kill switch,
 * https URI serving a valid registration file, no prior registration (receipt or on-chain balance),
 * balance >= 5x the estimated fee, wallet preview with a passing simulation and no risks, the
 * confirmation, then execute, wait for the receipt and read `agentId` from `Registered`.
 */
export async function registerIdentity(opts: RegisterOptions): Promise<RegisterResult> {
  const d: IdentityDeps = { ...defaultIdentityDeps(), ...opts.deps };
  const env = opts.env ?? process.env;
  const wallet = env.GAP_WALLET_ADDRESS ?? "";
  const uri = opts.uri ?? DEFAULT_AGENT_URI;
  const data = registerCalldata(uri);
  const now = d.now();
  const r: IdentityRecord = {
    version: 1,
    kind: "erc8004-identity",
    createdAt: new Date(now).toISOString(),
    mode: opts.live ? "live" : "dry-run",
    outcome: "REFUSED",
    refusal: null,
    registry: IDENTITY_REGISTRY,
    agentRegistry: AGENT_REGISTRY_ID,
    agentURI: uri,
    wallet,
    agentId: null,
    card: null,
    gas: null,
    tx: null,
    steps: [],
  };
  const step = (s: string, detail?: string) => {
    r.steps.push({ at: new Date(d.now()).toISOString(), step: s, ...(detail ? { detail } : {}) });
    d.log(s, detail);
  };
  let broadcast = false;
  const finish = (err?: unknown): RegisterResult => {
    if (err !== undefined) {
      const code = err instanceof Refusal ? err.code : "ERROR";
      r.refusal = { code, message: err instanceof Error ? err.message : String(err) };
      if (r.outcome !== "PENDING") r.outcome = broadcast ? "FAILED" : "REFUSED";
      step(r.outcome === "REFUSED" ? "refused" : "stopped", `${code}: ${r.refusal.message}`);
    }
    if (opts.attemptsDir) writeJson(join(opts.attemptsDir, `${r.createdAt.replace(/[:.]/g, "-")}-identity-${r.mode}.json`), r);
    const keep = opts.recordPath && (r.outcome === "REGISTERED" || broadcast);
    return { record: r, path: keep ? writeJson(opts.recordPath!, r) : null };
  };

  try {
    commonRails(env, wallet);
    const prior = opts.recordPath ? readIdentityRecord(opts.recordPath) : null;
    if (prior && (prior.agentId || prior.tx?.txHash)) {
      throw new Refusal("ALREADY_REGISTERED", `receipts/identity.json already records agent ${prior.agentId ?? "?"}${prior.tx?.txHash ? ` (tx ${prior.tx.txHash})` : ""}; not registering twice.`);
    }
    checkAgentUri(uri);
    const card = parseAgentCard(await d.fetchJson(uri));
    r.card = { name: card.name, services: card.services.map((s) => s.name) };
    step("agent card", `${card.name}: ${r.card.services.join(", ")}`);
    const owned = await d.chain.agentCount(wallet);
    if (owned > 0n) throw new Refusal("ALREADY_REGISTERED", `The wallet already owns ${owned} agent NFT(s) in the IdentityRegistry; not registering twice.`);

    const [estimate, gasPrice, balance] = await Promise.all([d.chain.estimateGas(wallet, IDENTITY_REGISTRY, data), d.chain.gasPrice(), d.chain.balance(wallet)]);
    const gas = (estimate * GAS_PAD_PCT) / 100n;
    const fee = gas * gasPrice;
    const required = fee * IDENTITY_FEE_MULTIPLE;
    r.gas = { estimate: estimate.toString(), gasPriceWei: gasPrice.toString(), feeWei: fee.toString(), feeBnb: units(fee), balanceWei: balance.toString(), requiredWei: required.toString() };
    step("gas", `${estimate} gas at ${Number(gasPrice) / 1e9} gwei: about ${units(fee).toFixed(8)} BNB; balance ${units(balance).toFixed(6)} BNB`);
    if (balance < required) {
      throw new Refusal("INSUFFICIENT_GAS", `The wallet holds ${units(balance).toFixed(8)} BNB; the fee rail wants ${IDENTITY_FEE_MULTIPLE}x the ${units(fee).toFixed(8)} BNB fee (${units(required).toFixed(8)} BNB).`);
    }

    const call: ContractCall = { from: wallet, to: IDENTITY_REGISTRY, value: "0", data };
    r.tx = { to: call.to, value: call.value, data };
    step("wallet preview");
    const p = await d.baw.preview(call);
    r.tx.preview = { requestId: p.requestId, requireConfirmation: p.requireConfirmation, simulationOk: p.simulationOk, risks: p.risks };
    if (!p.simulationOk) throw new Refusal("PREVIEW_REJECTED", `Agentic Wallet simulation failed: ${p.simulationError ?? "unknown error"}.`);
    if (p.risks.length) throw new Refusal("PREVIEW_REJECTED", `Agentic Wallet risk scan flagged the call: ${JSON.stringify(p.risks).slice(0, 300)}.`);

    if (!opts.live) {
      r.outcome = "SIMULATED";
      step("dry run: previewed and simulated; not sent");
      return finish();
    }
    const summary =
      `Register ${wallet} as an ERC-8004 agent on BSC (IdentityRegistry ${IDENTITY_REGISTRY})?\n` +
      `agentURI ${uri}\nGas about ${units(fee).toFixed(8)} BNB; no value is sent.` +
      (p.requireConfirmation ? "\nThe wallet will also ask you to confirm in the Binance app." : "");
    if (!(await d.confirm(summary))) throw new Refusal("USER_DECLINED", "Declined at the confirmation prompt.");

    const since = d.now();
    step("execute");
    const res = await d.baw.execute(p.requestId);
    r.tx.broadcastStatus = res.status;
    let hash = res.txHash;
    if (!hash && res.status === "PENDING_CONFIRMATION") {
      step("waiting for confirmation in the Binance app");
      for (let waited = 0; !hash && waited < PENDING_TIMEOUT_MS; waited += PENDING_POLL_MS) {
        await d.sleep(PENDING_POLL_MS);
        hash = await d.baw.findTxSince(since - 60_000, IDENTITY_REGISTRY).catch(() => null);
      }
    }
    if (!hash) {
      broadcast = true;
      r.outcome = "PENDING";
      throw new Refusal("PENDING_TIMEOUT", `No transaction hash (status ${res.status}); check the Binance app before retrying.`);
    }
    broadcast = true;
    r.tx.txHash = hash;
    r.tx.bscscan = bscTxUrl(hash);
    step("broadcast", hash);
    const receipt = await d.chain.waitForReceipt(hash);
    r.tx.blockNumber = receipt.blockNumber.toString();
    r.tx.gasUsed = receipt.gasUsed.toString();
    r.tx.gasCostBnb = units(receipt.gasUsed * receipt.effectiveGasPrice);
    if (receipt.status !== "success") throw new Refusal("TX_REVERTED", `The registration reverted on-chain (${hash}).`);
    const ev = parseRegistered(receipt.logs);
    if (!ev) throw new Refusal("NO_REGISTERED_EVENT", `The transaction ${hash} succeeded but emitted no Registered event from the registry.`);
    if (lower(ev.owner) !== lower(wallet)) throw new Refusal("NO_REGISTERED_EVENT", `Registered names owner ${ev.owner}, not the wallet ${wallet}.`);
    r.agentId = ev.agentId.toString();
    r.outcome = "REGISTERED";
    step("registered", `agentId ${r.agentId} in block ${receipt.blockNumber}`);
    return finish();
  } catch (err) {
    return finish(err);
  }
}

// ---------- show ----------

export interface IdentityView {
  agentId: string;
  owner: string;
  agentURI: string;
  card: AgentCard | null;
  /** The card lists `{agentId, agentRegistry}` for this registration (ERC-8004's back-link). */
  pointsBack: boolean;
  issues: string[];
}

/** Reads `tokenURI` and `ownerOf`, fetches the card and checks it names this agentId back. */
export async function showIdentity(agentId: bigint, deps: Partial<IdentityDeps> = {}): Promise<IdentityView> {
  const d = { ...defaultIdentityDeps(), ...deps };
  const [agentURI, owner] = await Promise.all([d.chain.tokenURI(agentId), d.chain.ownerOf(agentId)]);
  const issues: string[] = [];
  let card: AgentCard | null = null;
  try {
    checkAgentUri(agentURI);
    card = parseAgentCard(await d.fetchJson(agentURI));
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err));
  }
  const pointsBack = card ? cardRegistrationsFor(card).includes(agentId) : false;
  if (card && !pointsBack) issues.push(`The card's registrations do not list agentId ${agentId} at ${AGENT_REGISTRY_ID}.`);
  return { agentId: agentId.toString(), owner, agentURI, card, pointsBack, issues };
}
