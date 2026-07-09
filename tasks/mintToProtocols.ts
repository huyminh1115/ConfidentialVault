import { FhevmType } from "@fhevm/hardhat-plugin";
import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * Task to mint underlying tokens to a single address
 *
 * This task mints 1_000_000 tokens to a specific address you provide.
 * The underlying token must be deployed first using the InvestmentVault deploy script.
 *
 * Usage:
 *   npx hardhat --network localhost task:mint-to-protocols --to 0x...
 *   npx hardhat --network sepolia task:mint-to-protocols --to 0x...
 *   npx hardhat --network localhost task:mint-to-protocols --to 0x... --amount 2000000
 */
task("task:mint-to-protocols", "Mints underlying tokens to a single address")
  // We keep the same task name to avoid breaking existing scripts.
  // But the behavior is now explicit: mint to ONE destination address only.
  .addParam("to", "Destination address to mint to (required)")
  .addOptionalParam("amount", "Amount to mint (default: 1000000)", "1000000")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, deployments, fhevm } = hre;

    // Validate the destination address early. This avoids wasting time on deployments / FHE init.
    const to = String(taskArguments.to || "").trim();
    if (!ethers.isAddress(to)) {
      throw new Error(`Invalid destination address provided via --to: "${to}"`);
    }

    // Parse the amount parameter
    const amount = BigInt(taskArguments.amount || "1000000");
    if (amount <= 0n) {
      throw new Error("Amount must be greater than 0");
    }

    console.log(`\nMinting ${amount.toString()} tokens to ${to}...\n`);

    // Initialize FHEVM for CLI operations
    // Handle initialization errors that may occur if contracts are already deployed
    await fhevm.initializeCLIApi();

    // Get the deployer signer (who is the owner of the underlying token)
    const signers = await ethers.getSigners();
    const deployer = signers[0];

    // Get the underlying token deployment
    let underlyingDeployment;
    try {
      underlyingDeployment = await deployments.get("ERC7984MintableBurnable");
    } catch {
      throw new Error(
        "ERC7984MintableBurnable not found. Please deploy it first using: pnpm hardhat deploy --tags InvestmentVault",
      );
    }

    const underlyingAddress = underlyingDeployment.address;
    console.log(`Underlying Token: ${underlyingAddress}`);

    // Get the underlying token contract
    const underlyingContract = await ethers.getContractAt("ERC7984MintableBurnable", underlyingAddress);

    console.log("\n" + "=".repeat(60));
    console.log("Starting minting process...");
    console.log("=".repeat(60));

    try {
      console.log(`\nMinting ${amount.toString()} tokens to destination address...`);

      // Create encrypted input for minting.
      // Important: the encrypted input is created for the deployer's address (the caller).
      // This matches how the ERC7984 confidential mint expects the proof to be tied to the caller.
      const encrypted = await fhevm.createEncryptedInput(underlyingAddress, deployer.address).add64(amount).encrypt();

      // Mint tokens to the destination address.
      // The deployer (owner) calls the mint function.
      const tx = await underlyingContract.connect(deployer).mint(to, encrypted.handles[0], encrypted.inputProof);

      console.log(`   Transaction hash: ${tx.hash}`);
      console.log(`   Waiting for confirmation...`);

      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error("Transaction receipt is null");
      }

      console.log(`   ✓ Transaction confirmed (block: ${receipt.blockNumber}, status: ${receipt.status})`);

      // Verify the balance by getting the encrypted balance
      const balance = await underlyingContract.confidentialBalanceOf(to);
      console.log(`   ✓ Encrypted balance: ${balance}`);

      // Try to decrypt the balance (only works in mock mode)
      if (fhevm.isMock) {
        try {
          const clearBalance = await fhevm.userDecryptEuint(
            FhevmType.euint64,
            balance.toString(),
            underlyingAddress,
            deployer,
          );
          console.log(`   ✓ Decrypted balance: ${clearBalance.toString()}`);
        } catch {
          console.log(`   ⚠ Could not decrypt balance (this is normal on non-mock networks)`);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`   ✗ Failed to mint to ${to}:`, message);
      throw err;
    }

    console.log("\n" + "=".repeat(60));
    console.log("Minting Summary:");
    console.log("=".repeat(60));
    console.log(`Underlying Token: ${underlyingAddress}`);
    console.log(`Destination: ${to}`);
    console.log(`Amount: ${amount.toString()}`);
    console.log("=".repeat(60));
    console.log("\n✓ All minting operations completed successfully!");
  });
