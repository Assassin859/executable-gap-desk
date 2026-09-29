import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, toFunctionSelector, type Log, type TransactionReceipt } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_REGISTRY_ID,
  DEFAULT_AGENT_URI,
  IDENTITY_REGISTRY,
  identityRegistryAbi,
  parseAgentCard,
  parseRegistered,
  registerCalldata,
  registerIdentity,
  showIdentity,
  type IdentityDeps,
} from "../src/index";

const W = "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65";
const env = { GAP_WALLET_ADDRESS: W } as NodeJS.ProcessEnv;
const NOW = Date.parse("2026-09-29T21:00:00Z");
const TX = `0x${"ef".repeat(32)}`;
const cardPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/.well-known/agent-card.json");
const card = () => JSON.parse(readFileSync(cardPath, "utf8")) as Record<string, unknown>;

function registeredLog(agentId: bigint, owner: `0x${string}` = W, address = IDENTITY_REGISTRY): Log {
  return {
    address,
    topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: "Registered", args: { agentId, owner } }),
    data: encodeAbiParameters([{ type: "string" }], [DEFAULT_AGENT_URI]),
    blockNumber: 1n,
    blockHash: `0x${"00".repeat(32)}`,
    logIndex: 0,
    transactionHash: TX,
    transactionIndex: 0,
    removed: false,
  } as unknown as Log;
}

function deps(o: { balance?: bigint; owned?: bigint; card?: unknown; simulationOk?: boolean; risks?: unknown[]; status?: "success" | "reverted"; logs?: Log[]; confirm?: boolean } = {}) {
  const d: IdentityDeps = {
    chain: {
      balance: vi.fn(async () => o.balance ?? 963_000_000_000_000n),
      agentCount: vi.fn(async () => o.owned ?? 0n),
      estimateGas: vi.fn(async () => 150_000n),
      gasPrice: vi.fn(async () => 50_000_000n),
      waitForReceipt: vi.fn(async () => ({ status: o.status ?? "success", blockNumber: 99n, gasUsed: 140_000n, effectiveGasPrice: 50_000_000n, logs: o.logs ?? [registeredLog(42n)] }) as unknown as TransactionReceipt),
      tokenURI: vi.fn(async () => DEFAULT_AGENT_URI),
      ownerOf: vi.fn(async () => W),
    },
    fetchJson: vi.fn(async () => o.card ?? card()),
    baw: {
      preview: vi.fn(async () => ({ requestId: "req-1", requireConfirmation: false, expiresAt: null, simulationOk: o.simulationOk ?? true, simulationError: o.simulationOk === false ? "reverted" : null, risks: o.risks ?? [], raw: {} })),
      execute: vi.fn(async () => ({ status: "SUCCESS", txHash: TX, raw: {} })),
      findTxSince: vi.fn(async () => null),
    },
    confirm: vi.fn(async () => o.confirm ?? true),
    now: () => NOW,
    sleep: vi.fn(async () => {}),
    log: () => {},
  };
  return d;
}

const tmp = () => mkdtempSync(join(tmpdir(), "gap-identity-"));

describe("ERC-8004 building blocks", () => {
  it("the published agent card is a valid registration-v1 file", () => {
    const c = parseAgentCard(card());
    expect(c.x402Support).toBe(true);
    expect(c.services.map((s) => s.name)).toEqual(expect.arrayContaining(["web", "x402", "x402-gap", "x402-route", "MCP"]));
    expect(c.registrations.every((r) => r.agentRegistry === AGENT_REGISTRY_ID)).toBe(true);
    expect(() => parseAgentCard({ ...card(), type: "nope" })).toThrow(/registration-v1/);
    expect(() => parseAgentCard({ ...card(), image: "http://x" })).toThrow(/image/);
  });

  it("encodes register(string) calldata", () => {
    const data = registerCalldata(DEFAULT_AGENT_URI);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("register(string)"));
    expect(decodeFunctionData({ abi: identityRegistryAbi, data }).args).toEqual([DEFAULT_AGENT_URI]);
  });

  it("parses Registered only from the registry itself", () => {
    expect(parseRegistered([registeredLog(7n)])).toEqual({ agentId: 7n, agentURI: DEFAULT_AGENT_URI, owner: W });
    expect(parseRegistered([registeredLog(7n, W, "0x0000000000000000000000000000000000000bad")])).toBeNull();
  });
});

describe("registerIdentity", () => {
  it("dry run checks the card, the fee rail and the wallet preview, and sends nothing", async () => {
    const d = deps();
    const dir = tmp();
    const { record, path } = await registerIdentity({ env, deps: d, recordPath: join(dir, "identity.json"), attemptsDir: join(dir, "identity") });
    expect(record.outcome).toBe("SIMULATED");
    expect(record.gas).toMatchObject({ estimate: "150000", feeWei: (180_000n * 50_000_000n).toString() });
    expect(vi.mocked(d.baw.preview).mock.calls[0]![0]).toEqual({ from: W, to: IDENTITY_REGISTRY, value: "0", data: registerCalldata(DEFAULT_AGENT_URI) });
    expect(d.baw.execute).not.toHaveBeenCalled();
    expect(path).toBeNull();
  });

  it("the fee rail refuses when the balance is under 5x the estimated fee", async () => {
    const fee = 180_000n * 50_000_000n;
    const d = deps({ balance: fee * 5n - 1n });
    const { record } = await registerIdentity({ env, live: true, deps: d, recordPath: null });
    expect(record).toMatchObject({ outcome: "REFUSED", refusal: { code: "INSUFFICIENT_GAS" } });
    expect(d.baw.preview).not.toHaveBeenCalled();
    expect((await registerIdentity({ env, live: true, deps: deps({ balance: fee * 5n }), recordPath: null })).record.outcome).toBe("REGISTERED");
  });

  it("registers, reads agentId from Registered and writes receipts/identity.json", async () => {
    const dir = tmp();
    const recordPath = join(dir, "identity.json");
    const d = deps();
    const { record, path } = await registerIdentity({ env, live: true, deps: d, recordPath });
    expect(record).toMatchObject({ outcome: "REGISTERED", agentId: "42", tx: { txHash: TX, blockNumber: "99" } });
    expect(path).toBe(recordPath);
    expect(JSON.parse(readFileSync(recordPath, "utf8")).agentId).toBe("42");

    const again = await registerIdentity({ env, live: true, deps: deps(), recordPath });
    expect(again.record).toMatchObject({ outcome: "REFUSED", refusal: { code: "ALREADY_REGISTERED" } });
  });

  it("refuses when the wallet already owns an agent on-chain, even without a receipt", async () => {
    const d = deps({ owned: 1n });
    const { record } = await registerIdentity({ env, live: true, deps: d, recordPath: null });
    expect(record.refusal?.code).toBe("ALREADY_REGISTERED");
    expect(d.baw.preview).not.toHaveBeenCalled();
  });

  it("refuses a non-https URI, an invalid card, a failed simulation, a risk flag or a declined prompt", async () => {
    expect((await registerIdentity({ env, uri: "http://x.example/card.json", deps: deps(), recordPath: null })).record.refusal?.code).toBe("BAD_AGENT_URI");
    expect((await registerIdentity({ env, deps: deps({ card: { name: "x" } }), recordPath: null })).record.refusal?.code).toBe("BAD_AGENT_CARD");
    expect((await registerIdentity({ env, deps: deps({ simulationOk: false }), recordPath: null })).record.refusal?.code).toBe("PREVIEW_REJECTED");
    expect((await registerIdentity({ env, deps: deps({ risks: [{ type: "x" }] }), recordPath: null })).record.refusal?.code).toBe("PREVIEW_REJECTED");
    const declined = deps({ confirm: false });
    expect((await registerIdentity({ env, live: true, deps: declined, recordPath: null })).record.refusal?.code).toBe("USER_DECLINED");
    expect(declined.baw.execute).not.toHaveBeenCalled();
    expect((await registerIdentity({ env: { ...env, GAP_EXEC_DISABLED: "1" }, deps: deps(), recordPath: null })).record.refusal?.code).toBe("EXEC_DISABLED");
  });

  it("a mined transaction without Registered is FAILED and still recorded (no retry)", async () => {
    const dir = tmp();
    const recordPath = join(dir, "identity.json");
    const { record, path } = await registerIdentity({ env, live: true, deps: deps({ logs: [] }), recordPath });
    expect(record).toMatchObject({ outcome: "FAILED", refusal: { code: "NO_REGISTERED_EVENT" }, tx: { txHash: TX } });
    expect(path).toBe(recordPath);
    expect((await registerIdentity({ env, live: true, deps: deps(), recordPath })).record.refusal?.code).toBe("ALREADY_REGISTERED");
  });
});

describe("showIdentity", () => {
  it("checks that the card lists the agentId back", async () => {
    const withId = { ...card(), registrations: [{ agentId: 42, agentRegistry: AGENT_REGISTRY_ID }] };
    const ok = await showIdentity(42n, deps({ card: withId }));
    expect(ok).toMatchObject({ agentId: "42", owner: W, agentURI: DEFAULT_AGENT_URI, pointsBack: true, issues: [] });
    const missing = await showIdentity(42n, deps());
    expect(missing.pointsBack).toBe(false);
    expect(missing.issues[0]).toMatch(/do not list agentId 42/);
  });
});