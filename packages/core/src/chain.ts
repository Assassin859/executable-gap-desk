import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  http,
  keccak256,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { bsc } from "viem/chains";
import type { EvmTx } from "./trade";
import { NATIVE_BNB } from "./trade";

export const DEFAULT_BSC_RPC = "https://bsc-dataseed.bnbchain.org";
export const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * Storage layout of BSC-USD (BEP20USDT): Ownable `_owner` at slot 0, then `_balances` (1) and
 * `_allowances` (2). Verified against balanceOf/allowance with eth_getStorageAt; pinned in chain.test.ts.
 */
export const USDT_SLOTS = { balances: 1n, allowances: 2n } as const;

export const bscTxUrl = (hash: string) => `https://bscscan.com/tx/${hash}`;

export function bscClient(rpcUrl: string = process.env.BSC_RPC_URL || DEFAULT_BSC_RPC): PublicClient {
  return createPublicClient({ chain: bsc, transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) }) as PublicClient;
}

const isNative = (token: string) => token.toLowerCase() === NATIVE_BNB.toLowerCase();

/** The chain reads execution needs; injectable so tests never touch an RPC. */
export interface ChainReader {
  balance(token: string, owner: string): Promise<bigint>;
  allowance(token: string, owner: string, spender: string): Promise<bigint>;
  waitForReceipt(hash: string, timeoutMs?: number): Promise<TransactionReceipt>;
  decimals?(token: string): Promise<number>;
}

export function createChainReader(client: PublicClient = bscClient()): ChainReader {
  return {
    balance: (token, owner) =>
      isNative(token)
        ? client.getBalance({ address: owner as Address })
        : client.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner as Address] }),
    allowance: (token, owner, spender) =>
      client.readContract({ address: token as Address, abi: erc20Abi, functionName: "allowance", args: [owner as Address, spender as Address] }),
    waitForReceipt: (hash, timeoutMs = 120_000) =>
      client.waitForTransactionReceipt({ hash: hash as Hex, timeout: timeoutMs, pollingInterval: 1_500 }),
    decimals: async (token) =>
      isNative(token) ? 18 : Number(await client.readContract({ address: token as Address, abi: erc20Abi, functionName: "decimals" })),
  };
}

/** Decodes ERC-20 `approve(spender, amount)` calldata; anything else returns null. */
export function decodeApprove(data: string): { spender: string; amount: bigint } | null {
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: data as Hex });
    if (d.functionName !== "approve") return null;
    const [spender, amount] = d.args;
    return { spender, amount };
  } catch {
    return null;
  }
}

/** Sum of ERC-20 Transfer amounts of `token` into (`to`) or out of (`from`) an address in a receipt's logs. */
export function transferSum(logs: Log[], token: string, who: string, direction: "to" | "from"): bigint {
  const t = token.toLowerCase();
  const w = who.toLowerCase();
  return parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs, strict: false })
    .filter((l) => l.address.toLowerCase() === t && String(l.args[direction] ?? "").toLowerCase() === w)
    .reduce((sum, l) => sum + (l.args.value ?? 0n), 0n);
}

export function mappingSlot(key: string, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key as Address, slot]));
}

/** Slot of `allowances[owner][spender]` for a nested mapping at `slot`. */
export function nestedMappingSlot(owner: string, spender: string, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender as Address, mappingSlot(owner, slot)]));
}

export interface OverrideSim {
  ok: boolean;
  error: string | null;
  overrides: { token: string; balance: string; spender: string; allowance: string };
}

/**
 * eth_call of the exact swap tx against BSC mainnet state, with the wallet's USDT balance and router
 * allowance overridden. The router enforces `minReceiveAmount`, so a call that does not revert proves
 * this calldata would fill today even though the wallet is unfunded.
 */
export async function simulateWithOverrides(
  tx: EvmTx,
  o: { token: string; balance: bigint; spender: string; allowance: bigint },
  client: PublicClient = bscClient(),
): Promise<OverrideSim> {
  const overrides = { token: o.token, balance: o.balance.toString(), spender: o.spender, allowance: o.allowance.toString() };
  try {
    await client.call({
      account: tx.from as Address,
      to: tx.to as Address,
      data: tx.data as Hex,
      value: BigInt(tx.value),
      stateOverride: [
        {
          address: o.token as Address,
          stateDiff: [
            { slot: mappingSlot(tx.from, USDT_SLOTS.balances), value: toHex(o.balance, { size: 32 }) },
            { slot: nestedMappingSlot(tx.from, o.spender, USDT_SLOTS.allowances), value: toHex(o.allowance, { size: 32 }) },
          ],
        },
        { address: tx.from as Address, balance: 10n ** 17n },
      ],
    });
    return { ok: true, error: null, overrides };
  } catch (err) {
    const e = err as { shortMessage?: string; message?: string };
    return { ok: false, error: e.shortMessage ?? e.message ?? String(err), overrides };
  }
}
