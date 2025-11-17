import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import {
  CERC4626V2,
  MintableConfidentialFungibleToken,
  CERC4626V2__factory,
  MintableConfidentialFungibleToken__factory,
} from "../types";

// Constants for better maintainability
const OPERATOR_EXPIRY_OFFSET = 3600; // 1 hour
const BASE_RATE = 1_000_000n; // 10^6

// Test amounts as constants for better maintainability
const TEST_AMOUNTS = {
  aliceMint: 1_000_000n,
  bobMint: 2_000_000n,
  aliceDeposit: 400_000n,
  bobDeposit: 1_200_000n,
  yieldToVault: 600_000n,
  aliceWithdraw: 100_000n, // withdraw in assets
} as const;

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
};

// Helper functions to reduce code duplication and improve performance
class TestHelpers {
  /**
   * Creates encrypted input for minting
   */
  static async createEncryptedMint(contractAddress: string, user: HardhatEthersSigner, amount: bigint) {
    return await fhevm.createEncryptedInput(contractAddress, user.address).add64(amount).encrypt();
  }

  /**
   * Creates encrypted input for deposit/withdraw
   */
  static async createEncryptedDeposit(contractAddress: string, user: HardhatEthersSigner, amount: bigint) {
    return await fhevm.createEncryptedInput(contractAddress, user.address).add64(amount).encrypt();
  }

  /**
   * Mints confidential tokens to a user using the simple mint function
   */
  static async mintToUser(
    underlying: MintableConfidentialFungibleToken,
    mintToAddress: string,
    amount: bigint,
    deployer: HardhatEthersSigner,
    user?: HardhatEthersSigner, //  to get decrypted balance
  ) {
    // Use the simple mint function that takes euint64 directly
    const encrypted = await this.createEncryptedMint(await underlying.getAddress(), deployer, amount);
    await underlying["mint(address,bytes32,bytes)"](mintToAddress, encrypted.handles[0], encrypted.inputProof);

    const balance = await underlying.balanceOf(mintToAddress);

    let clearBalance = undefined;

    if (user) {
      clearBalance = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        balance.toString(),
        await underlying.getAddress(),
        user,
      );
    }
    return { balance, clearBalance };
  }

  /**
   * Sets operator for confidential transfers
   */
  static async setOperator(
    underlying: MintableConfidentialFungibleToken,
    user: HardhatEthersSigner,
    operatorAddress: string,
  ) {
    const expiry = BigInt((await time.latest()) + OPERATOR_EXPIRY_OFFSET);
    await underlying.connect(user).setOperator(operatorAddress, expiry);
  }

  /**
   * Performs a deposit and returns shares
   */
  static async performDeposit(vault: CERC4626V2, user: HardhatEthersSigner, amount: bigint, vaultAddress: string) {
    const encrypted = await this.createEncryptedDeposit(vaultAddress, user, amount);
    await vault.connect(user).deposit(user.address, encrypted.handles[0], encrypted.inputProof);

    const shares = await vault.balanceOf(user.address);
    const clearShares = await fhevm.userDecryptEuint(FhevmType.euint64, shares.toString(), vaultAddress, user);
    return { shares, clearShares };
  }

  /**
   * Performs a withdrawal and returns withdrawn shares
   */
  static async performWithdraw(vault: CERC4626V2, user: HardhatEthersSigner, amount: bigint, vaultAddress: string) {
    const encrypted = await this.createEncryptedDeposit(vaultAddress, user, amount);

    await vault.connect(user).withdraw(user.address, encrypted.handles[0], encrypted.inputProof);

    const shareLeft = await vault.balanceOf(user.address);
    const shareLeftClear = await fhevm.userDecryptEuint(FhevmType.euint64, shareLeft, vaultAddress, user);

    return { shareLeftClear };
  }

  /**
   * Redeems shares for assets and returns remaining shares
   */
  static async performRedeem(vault: CERC4626V2, user: HardhatEthersSigner, shares: bigint, vaultAddress: string) {
    const encryptedShares = await this.createEncryptedDeposit(vaultAddress, user, shares);

    await vault.connect(user).redeem(user.address, encryptedShares.handles[0], encryptedShares.inputProof);

    const shareLeft = await vault.balanceOf(user.address);
    const shareLeftClear = await fhevm.userDecryptEuint(FhevmType.euint64, shareLeft, vaultAddress, user);

    return { shareLeftClear };
  }

  /**
   * Gets decrypted balance for a user
   */
  static async getDecryptedBalance(
    contract: MintableConfidentialFungibleToken | CERC4626V2,
    user: HardhatEthersSigner,
    userAddress: string,
  ) {
    const balance = await contract.balanceOf(userAddress);
    const clearBalance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      balance.toString(),
      await contract.getAddress(),
      user,
    );
    return { balance, clearBalance };
  }

  /**
   * Converts decrypted asset balance to shares using on-chain ratio
   */
  static async convertToShares(
    vault: CERC4626V2,
    underlying: MintableConfidentialFungibleToken,
    user: HardhatEthersSigner,
  ) {
    const { clearBalance: assetBalance } = await this.getDecryptedBalance(underlying, user, user.address);
    const ratio = await vault.ratio();
    const computedShares = (assetBalance * ratio) / BASE_RATE;
    return { assetBalance, computedShares };
  }

  /**
   * Converts decrypted share balance to assets using on-chain ratio
   */
  static async convertToAssets(vault: CERC4626V2, user: HardhatEthersSigner) {
    const { clearBalance: shareBalance } = await this.getDecryptedBalance(vault, user, user.address);
    const ratio = await vault.ratio();
    const computedAssets = (shareBalance * BASE_RATE) / ratio;
    return { shareBalance, computedAssets };
  }
}

describe("cERC4626V2 deposit/ratio/withdraw flow", function () {
  // Cached variables for better performance
  let signers: Signers;
  let underlying: MintableConfidentialFungibleToken;
  let vault: CERC4626V2;
  let underlyingAddress: string;
  let vaultAddress: string;
  let initialRatio: bigint;

  /**
   * Optimized setup function with better error handling and performance
   */
  async function setupVault() {
    // Validate FHEVM environment
    if (!fhevm.isMock) {
      throw new Error("This hardhat test suite cannot run on Sepolia Testnet");
    }

    // Deploy underlying confidential token
    underlying = (await (
      await new MintableConfidentialFungibleToken__factory(signers.deployer).deploy(
        "Underlying",
        "uTKN",
        "",
        signers.deployer.address,
      )
    ).waitForDeployment()) as MintableConfidentialFungibleToken;

    // Deploy cERC4626V2 vault (it is also the share token)
    vault = (await (
      await new CERC4626V2__factory(signers.deployer).deploy("Vault Share", "vSHARE", "", await underlying.getAddress())
    ).waitForDeployment()) as CERC4626V2;

    // Cache addresses for better performance
    underlyingAddress = await underlying.getAddress();
    vaultAddress = await vault.getAddress();
    initialRatio = await vault.ratio();

    // Log setup information
    console.table({
      "underlying address": underlyingAddress,
      "vault address": vaultAddress,
      "initial ratio": initialRatio.toString(),
    });
  }

  before(async function () {
    const ethSigners: HardhatEthersSigner[] = await ethers.getSigners();
    signers = {
      deployer: ethSigners[0],
      alice: ethSigners[1],
      bob: ethSigners[2],
    };

    console.table({
      deployer: signers.deployer.address,
      alice: signers.alice.address,
      bob: signers.bob.address,
    });
  });

  describe("Test initialization", function () {
    before(async function () {
      await setupVault();
    });

    it("Should initialize with correct values", async function () {
      const asset = await vault.asset();
      expect(asset).to.eq(underlyingAddress);
      const ratio = await vault.ratio();
      expect(ratio).to.eq(BASE_RATE);
      const isOpen = await vault.isOpen();
      void expect(isOpen).to.be.true;
      const decimals = await vault.decimals();
      expect(decimals).to.eq(6); // Default decimals
    });

    it("Should have correct initial ratio", async function () {
      const ratio = await vault.ratio();
      expect(ratio).to.eq(BASE_RATE);
    });
  });

  describe("Test setIsOpen functionality", function () {
    before(async function () {
      await setupVault();
    });

    it("Should allow owner to close vault", async function () {
      await vault.connect(signers.deployer).setIsOpen(false);
      const isOpen = await vault.isOpen();
      void expect(isOpen).to.be.false;
    });

    it("Should allow owner to reopen vault", async function () {
      await vault.connect(signers.deployer).setIsOpen(true);
      const isOpen = await vault.isOpen();
      void expect(isOpen).to.be.true;
    });

    it("Should not allow non-owner to change isOpen", async function () {
      await expect(vault.connect(signers.alice).setIsOpen(false)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("Test deposit functionality", function () {
    before(async function () {
      await setupVault();
    });

    it("Should mint underlying to Alice", async function () {
      const { clearBalance } = await TestHelpers.mintToUser(
        underlying,
        signers.alice.address,
        TEST_AMOUNTS.aliceMint,
        signers.deployer,
        signers.alice,
      );
      expect(clearBalance).to.eq(TEST_AMOUNTS.aliceMint);
    });

    it("Should mint underlying to Bob", async function () {
      const { clearBalance } = await TestHelpers.mintToUser(
        underlying,
        signers.bob.address,
        TEST_AMOUNTS.bobMint,
        signers.deployer,
        signers.bob,
      );
      expect(clearBalance).to.eq(TEST_AMOUNTS.bobMint);
    });

    it("Should allow Alice to deposit when vault is open", async function () {
      await TestHelpers.setOperator(underlying, signers.alice, vaultAddress);

      const { clearShares } = await TestHelpers.performDeposit(
        vault,
        signers.alice,
        TEST_AMOUNTS.aliceDeposit,
        vaultAddress,
      );

      // With initial ratio = BASE_RATE, shares = assets * (BASE_RATE / BASE_RATE) = assets
      const expectedShares = TEST_AMOUNTS.aliceDeposit;
      expect(clearShares).to.eq(expectedShares);
    });

    it("Should allow Bob to deposit when vault is open", async function () {
      await TestHelpers.setOperator(underlying, signers.bob, vaultAddress);

      const { clearShares } = await TestHelpers.performDeposit(
        vault,
        signers.bob,
        TEST_AMOUNTS.bobDeposit,
        vaultAddress,
      );

      const expectedShares = TEST_AMOUNTS.bobDeposit;
      expect(clearShares).to.eq(expectedShares);
    });

    it("Should revert deposit when vault is closed", async function () {
      await vault.connect(signers.deployer).setIsOpen(false);

      const encrypted = await TestHelpers.createEncryptedDeposit(
        vaultAddress,
        signers.alice,
        TEST_AMOUNTS.aliceDeposit,
      );

      await expect(
        vault.connect(signers.alice).deposit(signers.alice.address, encrypted.handles[0], encrypted.inputProof),
      ).to.be.revertedWithCustomError(vault, "NotOpen");

      // Reopen vault for other tests
      await vault.connect(signers.deployer).setIsOpen(true);
    });
  });

  describe("Test convertToShares and convertToAssets", function () {
    before(async function () {
      await setupVault();
    });

    it("Should convert assets to shares correctly with initial ratio", async function () {
      // First, mint more assets than we deposit so some balance remains
      const mintAmount = 200_000n;
      const depositAmount = 100_000n;

      await TestHelpers.mintToUser(underlying, signers.alice.address, mintAmount, signers.deployer);
      await TestHelpers.setOperator(underlying, signers.alice, vaultAddress);
      await TestHelpers.performDeposit(vault, signers.alice, depositAmount, vaultAddress);

      // Now test convertToShares using decrypted balances
      const { assetBalance, computedShares } = await TestHelpers.convertToShares(vault, underlying, signers.alice);

      console.log("assetBalance: ", assetBalance);
      console.log("computedShares: ", computedShares);

      expect(assetBalance).to.be.gt(0n);
      expect(computedShares).to.eq(assetBalance);
    });

    it("Should convert shares to assets correctly with initial ratio", async function () {
      // Use existing balance from previous test
      const { shareBalance, computedAssets } = await TestHelpers.convertToAssets(vault, signers.alice);

      console.log("shareBalance: ", shareBalance);
      console.log("computedAssets: ", computedAssets);

      expect(shareBalance).to.be.gt(0n);
      expect(computedAssets).to.eq(shareBalance);
    });
  });

  describe("Test withdraw functionality", function () {
    before(async function () {
      await setupVault();
      // Setup: mint and deposit
      await TestHelpers.mintToUser(underlying, signers.alice.address, TEST_AMOUNTS.aliceMint, signers.deployer);
      await TestHelpers.setOperator(underlying, signers.alice, vaultAddress);
      await TestHelpers.performDeposit(vault, signers.alice, TEST_AMOUNTS.aliceDeposit, vaultAddress);
    });

    it("Should allow Alice to withdraw when vault is open", async function () {
      const { clearBalance: beforeBalance } = await TestHelpers.getDecryptedBalance(
        underlying,
        signers.alice,
        signers.alice.address,
      );

      await TestHelpers.performWithdraw(vault, signers.alice, TEST_AMOUNTS.aliceWithdraw, vaultAddress);

      const { clearBalance: afterBalance } = await TestHelpers.getDecryptedBalance(
        underlying,
        signers.alice,
        signers.alice.address,
      );

      // Check underlying increased by withdrawn assets
      expect(afterBalance - beforeBalance).to.eq(TEST_AMOUNTS.aliceWithdraw);
    });

    it("Should revert withdraw when vault is closed", async function () {
      await vault.connect(signers.deployer).setIsOpen(false);

      const encrypted = await TestHelpers.createEncryptedDeposit(
        vaultAddress,
        signers.alice,
        TEST_AMOUNTS.aliceWithdraw,
      );

      await expect(
        vault.connect(signers.alice).withdraw(signers.alice.address, encrypted.handles[0], encrypted.inputProof),
      ).to.be.revertedWithCustomError(vault, "NotOpen");

      // Reopen vault for other tests
      await vault.connect(signers.deployer).setIsOpen(true);
    });

    it("Should allow Alice to redeem shares for assets", async function () {
      const redeemShares = 50_000n;

      const { clearBalance: beforeBalance } = await TestHelpers.getDecryptedBalance(
        underlying,
        signers.alice,
        signers.alice.address,
      );

      await TestHelpers.performRedeem(vault, signers.alice, redeemShares, vaultAddress);

      const { clearBalance: afterBalance } = await TestHelpers.getDecryptedBalance(
        underlying,
        signers.alice,
        signers.alice.address,
      );

      expect(afterBalance - beforeBalance).to.eq(redeemShares);
    });
  });

  describe("Test happy case: deposit, ratio update, withdraw", function () {
    before(async function () {
      await setupVault();
    });

    it("Test mint underlying to Alice", async function () {
      const { clearBalance } = await TestHelpers.mintToUser(
        underlying,
        signers.alice.address,
        TEST_AMOUNTS.aliceMint,
        signers.deployer,
        signers.alice,
      );
      expect(clearBalance).to.eq(TEST_AMOUNTS.aliceMint);
    });

    it("Test mint underlying to Bob", async function () {
      const { clearBalance } = await TestHelpers.mintToUser(
        underlying,
        signers.bob.address,
        TEST_AMOUNTS.bobMint,
        signers.deployer,
        signers.bob,
      );
      expect(clearBalance).to.eq(TEST_AMOUNTS.bobMint);
    });

    it("Test Alice deposits into vault", async function () {
      await TestHelpers.setOperator(underlying, signers.alice, vaultAddress);

      const { clearShares } = await TestHelpers.performDeposit(
        vault,
        signers.alice,
        TEST_AMOUNTS.aliceDeposit,
        vaultAddress,
      );

      console.log("alice shares: ", clearShares);
      // With initial ratio = BASE_RATE, shares = assets
      expect(clearShares).to.eq(TEST_AMOUNTS.aliceDeposit);
    });

    it("Test Bob deposits into vault", async function () {
      await TestHelpers.setOperator(underlying, signers.bob, vaultAddress);

      const { clearShares } = await TestHelpers.performDeposit(
        vault,
        signers.bob,
        TEST_AMOUNTS.bobDeposit,
        vaultAddress,
      );

      console.log("bob shares: ", clearShares);
      expect(clearShares).to.eq(TEST_AMOUNTS.bobDeposit);
    });

    it("Test mint yield to vault", async function () {
      await TestHelpers.mintToUser(underlying, vaultAddress, TEST_AMOUNTS.yieldToVault, signers.deployer);

      // that's all, we can't check the balance of the vault, because it is confidential
    });

    it("Test vault manager decrypts snapshot after update", async function () {
      await vault.connect(signers.deployer).updateSnapshot();

      const vaultAddr = await vault.getAddress();
      const snapshotAssets = await vault.snapshotTotalAssets();
      const snapshotShares = await vault.snapshotTotalShares();

      const decryptedAssets = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        snapshotAssets,
        vaultAddr,
        signers.deployer,
      );

      const decryptedShares = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        snapshotShares,
        vaultAddr,
        signers.deployer,
      );

      console.log("decryptedAssets: ", decryptedAssets);
      console.log("decryptedShares: ", decryptedShares);

      const expectedAssets = TEST_AMOUNTS.aliceDeposit + TEST_AMOUNTS.bobDeposit + TEST_AMOUNTS.yieldToVault;
      const expectedShares = TEST_AMOUNTS.aliceDeposit + TEST_AMOUNTS.bobDeposit;

      expect(decryptedAssets).to.eq(expectedAssets);
      expect(decryptedShares).to.eq(expectedShares);
    });

    it("Test request ratio update after yield", async function () {
      const totalShares = TEST_AMOUNTS.aliceDeposit + TEST_AMOUNTS.bobDeposit;
      const totalAssetsAfterYield = totalShares + TEST_AMOUNTS.yieldToVault;

      console.log("totalShares outside: ", totalShares);
      console.log("totalAssetsAfterYield outside: ", totalAssetsAfterYield);

      const newRatio = (totalShares * BASE_RATE) / totalAssetsAfterYield;
      const calculatedShares = (totalAssetsAfterYield * newRatio) / BASE_RATE;

      const residual = totalShares - calculatedShares;

      const encryptedResidual = await TestHelpers.createEncryptedDeposit(vaultAddress, signers.deployer, residual);

      const tx = await vault
        .connect(signers.deployer)
        .requestUpdateRatio(newRatio, encryptedResidual.handles[0], encryptedResidual.inputProof);

      const receipt = await tx.wait();
      void expect(receipt).to.not.be.null;

      await fhevm.awaitDecryptionOracle();
    });

    it("Test Alice redeem shares for assets", async function () {
      const { clearBalance: beforeBalance } = await TestHelpers.getDecryptedBalance(
        underlying,
        signers.alice,
        signers.alice.address,
      );

      // get current share of alice
      const { clearBalance: aliceShares } = await TestHelpers.getDecryptedBalance(
        vault,
        signers.alice,
        signers.alice.address,
      );

      await TestHelpers.performRedeem(vault, signers.alice, aliceShares, vaultAddress);

      const { clearBalance: afterBalance } = await TestHelpers.getDecryptedBalance(
        underlying,
        signers.alice,
        signers.alice.address,
      );

      // Check underlying increased by withdrawn assets

      expect(afterBalance - beforeBalance).to.eq(
        TEST_AMOUNTS.aliceDeposit +
          (TEST_AMOUNTS.yieldToVault * TEST_AMOUNTS.aliceDeposit) /
            (TEST_AMOUNTS.aliceDeposit + TEST_AMOUNTS.bobDeposit),
      );
    });
  });

  describe("Test view functions", function () {
    before(async function () {
      await setupVault();
    });

    it("Should return correct asset address", async function () {
      expect(await vault.asset()).to.eq(underlyingAddress);
    });

    it("Should return maxDeposit as type(uint64).max", async function () {
      const maxDeposit = await vault.maxDeposit(signers.alice.address);
      expect(maxDeposit).to.eq(BigInt("18446744073709551615")); // type(uint64).max
    });

    it("Should return totalAssets as encrypted balance", async function () {
      const totalAssets = await vault.totalAssets();
      void expect(totalAssets).to.not.be.null;
      void expect(totalAssets).to.not.be.undefined;
      void expect(typeof totalAssets).to.eq("string");
    });

    it("Should return totalShares as encrypted totalSupply", async function () {
      const totalShares = await vault.totalShares();
      void expect(totalShares).to.not.be.null;
      void expect(totalShares).to.not.be.undefined;
      void expect(typeof totalShares).to.eq("string");
    });
  });
});
