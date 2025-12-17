import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import {
  ConfidentialVault,
  ERC7984MintableBurnable,
  ConfidentialVault__factory,
  ERC7984MintableBurnable__factory,
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

type ClearPosition = {
  token: string;
  weight: bigint;
  riskFactor: bigint;
};

type ClearStrategy = {
  maxRiskFactor: bigint;
  minRiskFactor: bigint;
  positions: ClearPosition[];
};

// Helper functions to reduce code duplication and improve performance
class TestHelpers {
  /**
   * Creates encrypted input for minting
   */
  static async createEncryptedMint(contractAddress: string, user: HardhatEthersSigner, amount: bigint) {
    return await fhevm.createEncryptedInput(contractAddress, user.address).add64(amount).encrypt();
  }

  static async createEncryptedStrategy(contractAddress: string, user: HardhatEthersSigner, strategy: ClearStrategy) {
    let dataToEncrypt = fhevm.createEncryptedInput(contractAddress, user.address);

    for (const position of strategy.positions) {
      dataToEncrypt = dataToEncrypt.add64(position.weight);
    }

    return dataToEncrypt.encrypt();
  }

  /**
   * Converts a ClearStrategy to ConfidentialVault.SubmitStrategyStruct
   * Encrypts weights using createEncryptedStrategy, encrypts totalAssets separately,
   * and sets isValid to empty bytes (default encrypted boolean)
   * @param vaultAddress The address of the ConfidentialVault contract
   * @param user The signer to use for encryption
   * @param clearStrategy The clear strategy to convert
   * @returns An object containing the SubmitStrategyStruct and the inputProof needed for contract calls
   */
  static async convertClearStrategyToSubmitStrategyStruct(
    vaultAddress: string,
    user: HardhatEthersSigner,
    clearStrategy: ClearStrategy,
  ): Promise<{
    strategy: ConfidentialVault.SubmitStrategyStruct;
    weightsInputProof: Uint8Array<ArrayBufferLike>;
  }> {
    // Encrypt weights for all positions using createEncryptedStrategy
    // This returns handles array and a single inputProof for all weights
    const encryptedWeights = await this.createEncryptedStrategy(vaultAddress, user, clearStrategy);

    // Create encrypted positions array with encrypted weights
    // Each position uses a handle from the encryptedWeights array
    const encryptedPositions: ConfidentialVault.SubmitPositionStruct[] = [];
    for (let i = 0; i < clearStrategy.positions.length; i++) {
      const position = clearStrategy.positions[i];
      encryptedPositions.push({
        token: position.token,
        weight: encryptedWeights.handles[i], // Use the corresponding encrypted weight handle
        riskFactor: Number(position.riskFactor), // Convert to number for uint64
      });
    }

    // Create the SubmitStrategy struct
    const strategyStruct: ConfidentialVault.SubmitStrategyStruct = {
      maxRiskFactor: Number(clearStrategy.maxRiskFactor), // Convert to number for uint64
      minRiskFactor: Number(clearStrategy.minRiskFactor), // Convert to number for uint64
      positions: encryptedPositions,
    };

    return {
      strategy: strategyStruct,
      weightsInputProof: encryptedWeights.inputProof, // Input proof for all encrypted weights
    };
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
    someToken: ERC7984MintableBurnable,
    mintToAddress: string,
    amount: bigint,
    deployer: HardhatEthersSigner,
    user?: HardhatEthersSigner, //  to get decrypted balance
  ) {
    // Get contract address
    const contractAddress = await someToken.getAddress();

    // Create encrypted input for the deployer (who will call the mint function)
    // Following the pattern from FHECounter: encrypted input is created for the caller's address
    const encrypted = await this.createEncryptedMint(contractAddress, deployer, amount);

    // Mint tokens to the specified address (deployer calls as owner)
    // The proof is created by deployer, but tokens are minted to mintToAddress
    await someToken.connect(deployer).mint(mintToAddress, encrypted.handles[0], encrypted.inputProof);

    const balance = await someToken.confidentialBalanceOf(mintToAddress);

    let clearBalance = undefined;

    if (user) {
      clearBalance = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        balance.toString(),
        await someToken.getAddress(),
        user,
      );
    }
    return { balance, clearBalance };
  }

  /**
   * Sets operator for confidential transfers
   */
  static async setOperator(someToken: ERC7984MintableBurnable, user: HardhatEthersSigner, operatorAddress: string) {
    const expiry = BigInt((await time.latest()) + OPERATOR_EXPIRY_OFFSET);
    await someToken.connect(user).setOperator(operatorAddress, expiry);
  }

  /**
   * Performs a deposit and returns shares
   */
  static async performDeposit(
    vault: ConfidentialVault,
    user: HardhatEthersSigner,
    amount: bigint,
    vaultAddress: string,
  ) {
    const encrypted = await this.createEncryptedDeposit(vaultAddress, user, amount);
    await vault.connect(user).confidentialDeposit(user.address, encrypted.handles[0], encrypted.inputProof);

    const shares = await vault.confidentialBalanceOf(user.address);
    const clearShares = await fhevm.userDecryptEuint(FhevmType.euint64, shares.toString(), vaultAddress, user);
    return { shares, clearShares };
  }

  /**
   * Performs a withdrawal and returns withdrawn shares
   */
  static async performWithdraw(
    vault: ConfidentialVault,
    user: HardhatEthersSigner,
    amount: bigint,
    vaultAddress: string,
  ) {
    const encrypted = await this.createEncryptedDeposit(vaultAddress, user, amount);

    await vault.connect(user).confidentialWithdraw(user.address, encrypted.handles[0], encrypted.inputProof);

    const shareLeft = await vault.confidentialBalanceOf(user.address);
    const shareLeftClear = await fhevm.userDecryptEuint(FhevmType.euint64, shareLeft, vaultAddress, user);

    return { shareLeftClear };
  }

  /**
   * Redeems shares for assets and returns remaining shares
   */
  static async performRedeem(
    vault: ConfidentialVault,
    user: HardhatEthersSigner,
    shares: bigint,
    vaultAddress: string,
  ) {
    const encryptedShares = await this.createEncryptedDeposit(vaultAddress, user, shares);

    await vault.connect(user).redeem(user.address, encryptedShares.handles[0], encryptedShares.inputProof);

    const shareLeft = await vault.confidentialBalanceOf(user.address);
    const shareLeftClear = await fhevm.userDecryptEuint(FhevmType.euint64, shareLeft, vaultAddress, user);

    return { shareLeftClear };
  }

  /**
   * Gets decrypted balance for a user
   */
  static async getDecryptedBalance(
    contract: ERC7984MintableBurnable | ConfidentialVault,
    user: HardhatEthersSigner,
    userAddress: string,
  ) {
    const balance = await contract.confidentialBalanceOf(userAddress);
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
    vault: ConfidentialVault,
    someToken: ERC7984MintableBurnable,
    user: HardhatEthersSigner,
  ) {
    const { clearBalance: assetBalance } = await this.getDecryptedBalance(someToken, user, user.address);
    const ratio = await vault.ratio();
    const computedShares = (assetBalance * ratio) / BASE_RATE;
    return { assetBalance, computedShares };
  }

  /**
   * Converts decrypted share balance to assets using on-chain ratio
   */
  static async convertToAssets(vault: ConfidentialVault, user: HardhatEthersSigner) {
    const { clearBalance: shareBalance } = await this.getDecryptedBalance(vault, user, user.address);
    const ratio = await vault.ratio();
    const computedAssets = (shareBalance * BASE_RATE) / ratio;
    return { shareBalance, computedAssets };
  }

  /**
   * Deploys an ERC7984MintableBurnable token contract
   * @param deployer The signer that will deploy the contract and be set as owner
   * @param name Token name
   * @param symbol Token symbol
   * @param uri Token URI (optional, defaults to empty string)
   * @returns The deployed ERC7984MintableBurnable contract instance
   */
  static async deployERC7984MintableBurnable(
    deployer: HardhatEthersSigner,
    name: string,
    symbol: string,
    uri: string = "",
  ): Promise<ERC7984MintableBurnable> {
    // Deploy the contract
    // Constructor expects: (address owner, string name, string symbol, string uri)
    const deployment = await new ERC7984MintableBurnable__factory(deployer).deploy(
      deployer.address, // owner (first parameter)
      name, // name (second parameter)
      symbol, // symbol (third parameter)
      uri, // uri (fourth parameter)
    );

    // Wait for deployment to complete
    const contract = (await deployment.waitForDeployment()) as ERC7984MintableBurnable;

    // Ensure deployment is fully complete by getting the address
    await contract.getAddress();

    return contract;
  }
}

describe("ConfidentialVault deposit/ratio/withdraw flow", function () {
  // Cached variables for better performance
  let signers: Signers;
  let someToken: ERC7984MintableBurnable;
  let someToken2: ERC7984MintableBurnable;
  let someToken3: ERC7984MintableBurnable;
  let someToken4: ERC7984MintableBurnable;
  let someToken5: ERC7984MintableBurnable;

  let vault: ConfidentialVault;
  let someTokenAddress: string;
  let vaultAddress: string;
  let initialRatio: bigint;

  let clearStrategy: ClearStrategy;

  /**
   * Optimized setup function with better error handling and performance
   */
  async function setupVault() {
    // Validate FHEVM environment
    if (!fhevm.isMock) {
      throw new Error("This hardhat test suite cannot run on Sepolia Testnet");
    }

    // Deploy someToken confidential tokens using the helper function
    someToken = await TestHelpers.deployERC7984MintableBurnable(signers.deployer, "Underlying", "uTKN");
    someToken2 = await TestHelpers.deployERC7984MintableBurnable(signers.deployer, "Underlying2", "uTKN2");
    someToken3 = await TestHelpers.deployERC7984MintableBurnable(signers.deployer, "Underlying3", "uTKN3");
    someToken4 = await TestHelpers.deployERC7984MintableBurnable(signers.deployer, "Underlying4", "uTKN4");
    someToken5 = await TestHelpers.deployERC7984MintableBurnable(signers.deployer, "Underlying5", "uTKN5");

    clearStrategy = {
      maxRiskFactor: 6000n, // 60%
      minRiskFactor: 1000n, // 10%
      positions: [
        {
          token: await someToken.getAddress(),
          weight: 2500n, // 25%
          riskFactor: 2200n, // 22%
        },
        {
          token: await someToken2.getAddress(),
          weight: 2000n, // 20%
          riskFactor: 1000n, // 10%
        },
        {
          token: await someToken3.getAddress(),
          weight: 1500n, // 15%
          riskFactor: 3500n, // 35%
        },
        {
          token: await someToken4.getAddress(),
          weight: 2500n, // 25%
          riskFactor: 1500n, // 15%
        },
        {
          token: await someToken5.getAddress(),
          weight: 1500n, // 15%
          riskFactor: 2800n, // 28%
        },
      ],
    };

    // Deploy ConfidentialVault vault (it is also the share token)
    vault = (await (
      await new ConfidentialVault__factory(signers.deployer).deploy(
        "Vault Share",
        "vSHARE",
        "",
        await someToken.getAddress(),
      )
    ).waitForDeployment()) as ConfidentialVault;

    // Cache addresses for better performance
    someTokenAddress = await someToken.getAddress();
    vaultAddress = await vault.getAddress();
    initialRatio = await vault.ratio();

    // Log setup information
    console.table({
      "someToken address": someTokenAddress,
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
      expect(asset).to.eq(someTokenAddress);
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

  describe("Test submit strategy", function () {
    before(async function () {
      await setupVault();
    });

    it("Should submit strategy", async function () {
      const { strategy, weightsInputProof } = await TestHelpers.convertClearStrategyToSubmitStrategyStruct(
        vaultAddress,
        signers.deployer,
        clearStrategy,
      );

      await vault.connect(signers.deployer).submitStrategy(strategy, weightsInputProof);

      const strategyId = await vault.strategyCounter();
      expect(strategyId).to.eq(1);
    });

    it("Should finalize strategy", async function () {
      // get current strategy id
      const strategyCounter = await vault.strategyCounter();
      expect(strategyCounter).to.eq(1);

      // get request decrypt bool from contract
      const requestDecryptBool = (await vault.pendingStrategies(strategyCounter)).isValid;

      // Call the Zama Relayer to compute the decryption
      const publicDecryptResults = await fhevm.publicDecrypt([requestDecryptBool]);

      const abiEncodedClearRequestDecryptBool = publicDecryptResults.abiEncodedClearValues;
      const decryptionProof = publicDecryptResults.decryptionProof;

      // The clear value is also ABI-encoded
      const decodedRequestDecryptBool = ethers.AbiCoder.defaultAbiCoder().decode(
        ["bool"],
        abiEncodedClearRequestDecryptBool,
      )[0];

      console.log("decodedRequestDecryptBool: ", decodedRequestDecryptBool);

      await vault
        .connect(signers.deployer)
        .finalizeUpdateStrategy(strategyCounter, abiEncodedClearRequestDecryptBool, decryptionProof);

      // get current strategy id
      const currentStrategyId = await vault.currentStrategyId();
      expect(currentStrategyId).to.eq(strategyCounter);
    });
  });
});
