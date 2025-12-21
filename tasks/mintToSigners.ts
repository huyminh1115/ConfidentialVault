import { FhevmType } from "@fhevm/hardhat-plugin";
import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * Task to mint underlying tokens to the top 20 signers
 *
 * This task mints 1_000 tokens to each of the first 20 signers (accounts).
 * The underlying token must be deployed first using the InvestmentVault deploy script.
 *
 * Usage:
 *   npx hardhat --network localhost task:mint-to-signers
 *   npx hardhat --network sepolia task:mint-to-signers
 *   npx hardhat --network localhost task:mint-to-signers --amount 2000 --count 10
 */
task("task:mint-to-signers", "Mints underlying tokens to the top 20 signers")
  .addOptionalParam("amount", "Amount to mint to each signer (default: 1000)", "1000")
  .addOptionalParam("count", "Number of signers to mint to (default: 20)", "20")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, deployments, fhevm } = hre;

    // Parse the amount parameter
    const amount = BigInt(taskArguments.amount || "1000");
    if (amount <= 0n) {
      throw new Error("Amount must be greater than 0");
    }

    // Parse the count parameter
    const count = parseInt(taskArguments.count || "20");
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error("Count must be a positive integer");
    }

    console.log(`\nMinting ${amount.toString()} tokens to top ${count} signers...\n`);

    // Initialize FHEVM for CLI operations
    await fhevm.initializeCLIApi();

    // Get all signers
    const signers = await ethers.getSigners();
    const deployer = signers[0];

    // Check if we have enough signers
    if (signers.length < count) {
      console.warn(
        `Warning: Only ${signers.length} signers available, but ${count} requested. Minting to ${signers.length} signers instead.`,
      );
    }

    const signersToMint = signers.slice(0, Math.min(count, signers.length));
    console.log(`Will mint to ${signersToMint.length} signers:\n`);

    // Display signer addresses
    signersToMint.forEach((signer, index) => {
      console.log(`  ${index + 1}. ${signer.address}`);
    });

    // Get the underlying token deployment
    let underlyingDeployment;
    try {
      underlyingDeployment = await deployments.get("ERC7984MintableBurnable");
    } catch (error) {
      throw new Error(
        "ERC7984MintableBurnable not found. Please deploy it first using: pnpm hardhat deploy --tags InvestmentVault",
      );
    }

    const underlyingAddress = underlyingDeployment.address;
    console.log(`\nUnderlying Token: ${underlyingAddress}`);
    console.log("\n" + "=".repeat(60));
    console.log("Starting minting process...");
    console.log("=".repeat(60));

    // Get the underlying token contract
    const underlyingContract = await ethers.getContractAt("ERC7984MintableBurnable", underlyingAddress);

    // Mint tokens to each signer
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < signersToMint.length; i++) {
      const signer = signersToMint[i];
      const signerAddress = signer.address;

      try {
        console.log(`\n[${i + 1}/${signersToMint.length}] Minting ${amount.toString()} tokens to signer ${i + 1}...`);
        console.log(`   Address: ${signerAddress}`);

        // Create encrypted input for minting
        // The encrypted input is created for the deployer's address (the caller)
        const encrypted = await fhevm.createEncryptedInput(underlyingAddress, deployer.address).add64(amount).encrypt();

        // Mint tokens to the signer address
        // The deployer (owner) calls the mint function
        const tx = await underlyingContract
          .connect(deployer)
          .mint(signerAddress, encrypted.handles[0], encrypted.inputProof);

        console.log(`   Transaction hash: ${tx.hash}`);
        console.log(`   Waiting for confirmation...`);

        const receipt = await tx.wait();
        if (!receipt) {
          throw new Error("Transaction receipt is null");
        }

        console.log(`   ✓ Transaction confirmed (block: ${receipt.blockNumber}, status: ${receipt.status})`);

        // Verify the balance by getting the encrypted balance
        const balance = await underlyingContract.confidentialBalanceOf(signerAddress);
        console.log(`   ✓ Encrypted balance: ${balance}`);

        // Try to decrypt the balance (only works in mock mode)
        if (fhevm.isMock) {
          try {
            // Decrypt using the signer's key
            const clearBalance = await fhevm.userDecryptEuint(
              FhevmType.euint64,
              balance.toString(),
              underlyingAddress,
              signer,
            );
            console.log(`   ✓ Decrypted balance: ${clearBalance.toString()}`);
          } catch (decryptError) {
            console.log(`   ⚠ Could not decrypt balance (this is normal on non-mock networks)`);
          }
        }

        successCount++;
      } catch (error: any) {
        console.error(`   ✗ Failed to mint to signer ${i + 1} (${signerAddress}):`, error.message);
        failCount++;
        // Continue with next signer instead of throwing
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("Minting Summary:");
    console.log("=".repeat(60));
    console.log(`Underlying Token: ${underlyingAddress}`);
    console.log(`Total Signers:    ${signersToMint.length}`);
    console.log(`Successful:       ${successCount}`);
    console.log(`Failed:           ${failCount}`);
    console.log(`Amount per signer: ${amount.toString()} tokens`);
    console.log(`Total minted:     ${(BigInt(successCount) * amount).toString()} tokens`);
    console.log("=".repeat(60));

    if (failCount > 0) {
      console.log(`\n⚠ Warning: ${failCount} minting operation(s) failed.`);
      process.exit(1);
    } else {
      console.log("\n✓ All minting operations completed successfully!");
    }
  });
