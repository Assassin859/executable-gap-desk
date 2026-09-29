import { getAddress, isAddress, toHex, type Hex, type LocalAccount } from "viem";
import type { PaymentPayload } from "./b402";
import type { PaymentRequirement } from "./x402";

/**
 * A local-key x402 v2 buyer for `exact` / EIP-3009 requirements: the token's own
 * `transferWithAuthorization`, so the EIP-712 domain is the token (name and version from
 * `extra`, verifyingContract = `asset`) and the buyer needs no approval and no BNB.
 * The desk's own buyer signs with the Agentic Wallet (`baw`); this is for a second, independent EOA.
 */

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** EIP-3009 needs `block.timestamp > validAfter`; backdating avoids waiting on BSC's sub-second blocks. */
export const VALID_AFTER_BACKDATE_SECONDS = 60;

export class LocalPaymentError extends Error {}

export type Eip3009Authorization = {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

export function chainIdOf(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new LocalPaymentError(`Unsupported network "${network}" (expected eip155:<chainId>).`);
  return Number(m[1]);
}

export function eip3009TypedData(req: PaymentRequirement, auth: Eip3009Authorization) {
  if (req.scheme !== "exact" || req.extra?.assetTransferMethod !== "eip3009") {
    throw new LocalPaymentError(`Only exact/eip3009 requirements can be signed locally (got ${req.scheme}/${String(req.extra?.assetTransferMethod ?? "?")}).`);
  }
  const name = req.extra?.name;
  const version = req.extra?.version;
  if (typeof name !== "string" || typeof version !== "string") throw new LocalPaymentError("The requirement's extra is missing the EIP-712 name or version.");
  if (!isAddress(req.asset) || !isAddress(req.payTo)) throw new LocalPaymentError("The requirement's asset or payTo is not an address.");
  return {
    domain: { name, version, chainId: chainIdOf(req.network), verifyingContract: getAddress(req.asset) },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  };
}

export interface LocalPaymentOptions {
  account: LocalAccount;
  resourceUrl?: string;
  /** Milliseconds. */
  now?: number;
  nonce?: Hex;
  /** Refuse to sign more than this, in the token's smallest unit. */
  maxAmount: bigint;
  /** Refuse to sign unless payTo is this address. */
  expectPayTo?: string;
}

/** Signs one requirement and returns the x402 v2 payment payload (`accepted` is the requirement, unchanged). */
export async function signEip3009Payment(req: PaymentRequirement, o: LocalPaymentOptions): Promise<PaymentPayload> {
  const amount = BigInt(req.amount);
  if (amount <= 0n || amount > o.maxAmount) throw new LocalPaymentError(`The requirement asks for ${req.amount}, above the cap ${o.maxAmount}.`);
  if (o.expectPayTo && (!isAddress(req.payTo) || getAddress(req.payTo) !== getAddress(o.expectPayTo))) {
    throw new LocalPaymentError(`payTo ${req.payTo} is not the expected ${o.expectPayTo}.`);
  }
  const nowS = Math.floor((o.now ?? Date.now()) / 1000);
  const auth: Eip3009Authorization = {
    from: o.account.address,
    to: getAddress(req.payTo),
    value: req.amount,
    validAfter: String(nowS - VALID_AFTER_BACKDATE_SECONDS),
    validBefore: String(nowS + (req.maxTimeoutSeconds ?? 300)),
    nonce: o.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await o.account.signTypedData(eip3009TypedData(req, auth));
  return {
    x402Version: 2,
    ...(o.resourceUrl ? { resource: { url: o.resourceUrl } } : {}),
    accepted: req,
    payload: { signature, authorization: auth },
  };
}

export const encodePaymentSignature = (payload: PaymentPayload): string => Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
