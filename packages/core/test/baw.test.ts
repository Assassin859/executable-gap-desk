import { describe, expect, it, vi } from "vitest";
import { BawError, contractCallArgs, executeContractCall, findTxSince, parseBawOutput, previewContractCall } from "../src/baw";

/** Shape of a live `baw contract-call preview --json` (v1.10.0) for a BNB to USDT swap; ids shortened. */
const PREVIEW = `{
  "success": true,
  "data": {
    "requestId": "e383066f",
    "parsedTx": { "transactionType": "Swap", "tokenInAmount": 3300000000000000, "contractAddress": "0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5" },
    "simulationResult": {
      "balanceChanges": [{ "contractAddress": "0x55d398326f99059fF775485246999027B3197955", "change": 2511621521265890300, "owner": "0x1111111111111111111111111111111111111111", "tokenType": "Erc20" }],
      "simulationErrorDetail": null,
      "simulationCode": "000000000",
      "allowanceChanges": []
    },
    "risks": { "addresses": {}, "riskDetails": [], "riskBehaviors": [] },
    "requireConfirmation": false,
    "expiresAt": 1790695061277,
    "gasLimit": null
  }
}`;

const ok = (stdout: string, code: number | null = 0) => vi.fn(async (_args: string[]) => ({ code, stdout, stderr: "" }));

describe("baw wrapper", () => {
  it("builds preview args as an argv array (calldata is never shell-interpolated)", () => {
    const args = contractCallArgs({ from: "0xa", to: "0xb", value: "0", data: "0xdead;rm -rf" });
    expect(args).toEqual(["contract-call", "preview", "--binanceChainId", "56", "--from", "0xa", "--to", "0xb", "--value", "0", "--inputData", "0xdead;rm -rf", "--json"]);
  });

  it("parses a live-shaped preview", async () => {
    const run = ok(PREVIEW);
    const p = await previewContractCall({ from: "0xa", to: "0xb", value: "0", data: "0x" }, run);
    expect(p).toMatchObject({ requestId: "e383066f", requireConfirmation: false, simulationOk: true, simulationError: null, risks: [] });
    expect(p.expiresAt).toBe(1790695061277);
  });

  it("keeps printed digits of integers beyond 2^53 instead of rounding again", () => {
    const data = parseBawOutput({ code: 0, stdout: PREVIEW, stderr: "" }) as { simulationResult: { balanceChanges: Array<{ change: unknown }> } };
    expect(data.simulationResult.balanceChanges[0]!.change).toBe("2511621521265890300");
  });

  it("trusts the JSON body even after the Windows libuv crash exit code", () => {
    const stdout = `${PREVIEW}\nAssertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76`;
    expect(() => parseBawOutput({ code: 3221226505, stdout, stderr: "" })).not.toThrow();
  });

  it("turns success:false into a BawError with the message and code", () => {
    const stdout = JSON.stringify({ success: false, error: { code: 315008, message: "From token value greater than 5 USD" } });
    expect(() => parseBawOutput({ code: 1, stdout, stderr: "" })).toThrow(BawError);
    expect(() => parseBawOutput({ code: 1, stdout, stderr: "" })).toThrow("From token value greater than 5 USD (315008)");
  });

  it("fails clearly when there is no JSON at all", () => {
    expect(() => parseBawOutput({ code: 1, stdout: "", stderr: "not signed in" })).toThrow(/no JSON \(exit 1\): not signed in/);
  });

  it("an intercepted preview (no requestId) cannot be executed", async () => {
    await expect(previewContractCall({ from: "0xa", to: "0xb", value: "0", data: "0x" }, ok(JSON.stringify({ success: true, data: {} })))).rejects.toThrow(/no requestId/);
  });

  it("flags a failed wallet simulation and collects risks", async () => {
    const body = JSON.parse(PREVIEW);
    body.data.simulationResult.simulationCode = "300001";
    body.data.simulationResult.simulationErrorDetail = "execution reverted";
    body.data.risks.riskDetails = [{ level: "HIGH" }];
    const p = await previewContractCall({ from: "0xa", to: "0xb", value: "0", data: "0x" }, ok(JSON.stringify(body)));
    expect(p.simulationOk).toBe(false);
    expect(p.simulationError).toBe("execution reverted");
    expect(p.risks).toEqual([{ level: "HIGH" }]);
  });

  it("maps BROADCASTED and PENDING_CONFIRMATION execute results", async () => {
    const b = await executeContractCall("r1", ok(JSON.stringify({ success: true, data: { status: "BROADCASTED", txHash: "0xabc" } })));
    expect(b).toMatchObject({ status: "BROADCASTED", txHash: "0xabc" });
    const run = ok(JSON.stringify({ success: true, data: { status: "PENDING_CONFIRMATION" } }));
    const p = await executeContractCall("r2", run);
    expect(p).toMatchObject({ status: "PENDING_CONFIRMATION", txHash: null });
    expect(run.mock.calls[0]![0]).toEqual(["contract-call", "execute", "--requestId", "r2", "--json"]);
  });

  it("finds the tx hash in history after an in-app confirmation", async () => {
    const history = { success: true, data: { transactions: [{ txType: "transfer", txHash: "0x1" }, { txType: "contract", txHash: "0x2", to: "0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5" }] } };
    const run = ok(JSON.stringify(history));
    await expect(findTxSince(1000, "0xb44446b0c8e56988c34f7ff73ae904982b5fdda5", run)).resolves.toBe("0x2");
    expect(run.mock.calls[0]![0]).toContain("--startTime");
  });
});
