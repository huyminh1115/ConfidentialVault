import type { TransactionResponse } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

const shouldLogTxBytes = Boolean(process.env.REPORT_GAS || process.env.REPORT_TX_SIZE);

// Track transaction hashes to avoid duplicate logging
const loggedTxHashes = new Set<string>();
const selectorToLabel = new Map<string, string>();

function ensureSelectorMapInitialized() {
  if (selectorToLabel.size > 0) {
    return;
  }

  const artifactsDir = path.resolve(__dirname, "../../artifacts/contracts");
  if (!fs.existsSync(artifactsDir)) {
    return;
  }

  const stack: string[] = [artifactsDir];

  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (!entry.name.endsWith(".json") || entry.name.endsWith(".dbg.json")) {
        continue;
      }

      try {
        const raw = fs.readFileSync(entryPath, "utf-8");
        const artifact = JSON.parse(raw);
        if (!Array.isArray(artifact.abi)) {
          continue;
        }

        const contractName = artifact.contractName || path.basename(entry.name, ".json");

        for (const item of artifact.abi) {
          if (item?.type !== "function" || typeof item.name !== "string") {
            continue;
          }

          const inputs = Array.isArray(item.inputs)
            ? item.inputs.map((input: { type: string }) => input.type || "bytes")
            : [];
          const signature = `${item.name}(${inputs.join(",")})`;
          const selector = ethers.id(signature).slice(0, 10).toLowerCase();

          if (!selectorToLabel.has(selector)) {
            selectorToLabel.set(selector, `${contractName}.${item.name}`);
          }
        }
      } catch {
        // Ignore malformed artifacts
      }
    }
  }
}

function formatActionLabel(tx: TransactionResponse | null): string {
  if (!tx) {
    return "unknown";
  }

  if (!tx.to) {
    return "contract-creation";
  }

  ensureSelectorMapInitialized();
  const selector = (tx.data ?? "").slice(0, 10).toLowerCase();

  if (selector.length === 10 && selectorToLabel.has(selector)) {
    return selectorToLabel.get(selector)!;
  }

  return tx.to;
}

// Helper function to log transaction metrics
async function logTransactionMetrics(txHash: string) {
  if (loggedTxHashes.has(txHash)) {
    return;
  }

  try {
    const receipt = await ethers.provider.getTransactionReceipt(txHash);
    if (receipt) {
      const tx = await ethers.provider.getTransaction(txHash);
      const calldata = tx?.data ?? "0x";
      const txSizeBytes = Math.max((calldata.length - 2) / 2, 0);
      const gasUsed = receipt.gasUsed?.toString() ?? "0";
      const label = formatActionLabel(tx ?? null);

      console.log(`[tx-metrics] ${label} | gas=${gasUsed} | size=${txSizeBytes} bytes`);
      loggedTxHashes.add(txHash);
    }
  } catch {
    // Transaction might not be mined yet, ignore
  }
}

// Helper function to wrap a transaction response with logging
function wrapTransactionResponse(txResponse: TransactionResponse): TransactionResponse {
  // Only wrap if not already wrapped to avoid double logging
  const txResponseWithFlag = txResponse as TransactionResponse & { __txMetricsWrapped?: boolean };
  if (txResponseWithFlag.__txMetricsWrapped) {
    return txResponse;
  }

  const originalWait = txResponse.wait.bind(txResponse);

  txResponse.wait = async (...waitArgs) => {
    const receipt = await originalWait(...waitArgs);

    if (receipt) {
      // Log immediately when receipt is available
      await logTransactionMetrics(receipt.hash);
    }

    return receipt;
  };

  // Also try to log when transaction is first sent (in case wait() is never called)
  logTransactionMetrics(txResponse.hash).catch(() => {
    // Ignore errors, will log when receipt is available
  });

  txResponseWithFlag.__txMetricsWrapped = true;
  return txResponse;
}

if (shouldLogTxBytes) {
  // Patch signer's sendTransaction - this is the main entry point for all transactions
  const signerProto = HardhatEthersSigner.prototype as HardhatEthersSigner & {
    __txMetricsPatched?: boolean;
  };

  if (!signerProto.__txMetricsPatched) {
    const originalSendTransaction = signerProto.sendTransaction;

    signerProto.sendTransaction = async function (...args) {
      const txResponse: TransactionResponse = await originalSendTransaction.apply(this, args);
      return wrapTransactionResponse(txResponse);
    };

    signerProto.__txMetricsPatched = true;
  }
}
