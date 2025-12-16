// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, externalEuint64, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984MintableBurnable} from "./ERC7984MintableBurnable.sol";

/**
 * @title ConfidentialVault
 * @notice Confidential ERC4626 compatible vault with snapshot-based ratio updates.
 * @dev Built on top of MintableConfidentialFungibleToken and FHE primitives.
 */
contract ConfidentialVault is ERC7984MintableBurnable {
    struct Request {
        uint64 newRatio;
        ebool isCorrect;
    }

    uint8 private constant PRECISION_DECIMALS = 6;
    uint64 private constant BASE_RATE = uint64(10 ** PRECISION_DECIMALS);

    address private immutable cAsset;
    address public vaultManager;
    uint64 public ratio;
    bool public isOpen;

    euint64 public snapshotTotalAssets;
    euint64 public snapshotTotalShares;

    uint256 public requestCounter;

    mapping(uint256 requestId => Request request) public requests;

    uint8 private _underlyingDecimals;

    error NotOpen();
    error InvalidVaultManager();

    event EventRequestUpdateRatio(uint256 requestId, uint64 ratio);

    constructor(
        string memory name_,
        string memory symbol_,
        string memory uri_,
        address cAsset_
    ) ERC7984MintableBurnable(msg.sender, name_, symbol_, uri_) {
        uint8 assetDecimals = ERC7984(cAsset_).decimals();
        _underlyingDecimals = assetDecimals;
        cAsset = cAsset_;

        // init ratio as 10 ** BASE_RATE
        ratio = BASE_RATE;
        isOpen = true;
        vaultManager = msg.sender;
    }

    modifier onlyOpen() {
        if (!isOpen) {
            revert NotOpen();
        }
        _;
    }

    modifier onlyVaultManager() {
        if (msg.sender != vaultManager) {
            revert InvalidVaultManager();
        }
        _;
    }

    function setIsOpen(bool _isOpen) external onlyOwner {
        isOpen = _isOpen;
    }

    function setVaultManager(address newManager) external onlyOwner {
        if (newManager == address(0)) {
            revert InvalidVaultManager();
        }
        vaultManager = newManager;
    }

    function decimals() public view virtual override(ERC7984) returns (uint8) {
        return _underlyingDecimals;
    }

    function asset() public view virtual returns (address) {
        return address(cAsset);
    }

    function totalAssets() public view virtual returns (euint64) {
        return ERC7984(cAsset).confidentialBalanceOf(address(this));
    }

    function totalShares() public view virtual returns (euint64) {
        return super.confidentialTotalSupply();
    }

    function maxDeposit(address /*receiver*/) public view virtual returns (uint64) {
        return type(uint64).max;
    }

    function _handleDeposit(euint64 depositAmount) internal returns (euint64) {
        euint64 ableToContribute = FHE.sub(maxDeposit(msg.sender), depositAmount);
        ebool isOverMaxContribute = FHE.ge(depositAmount, ableToContribute);
        return FHE.select(isOverMaxContribute, ableToContribute, depositAmount);
    }

    function confidentialDeposit(
        address receiver,
        externalEuint64 encryptedAssetsAmount,
        bytes calldata inputProof
    ) public virtual onlyOpen returns (euint64) {
        euint64 depositAmount = FHE.fromExternal(encryptedAssetsAmount, inputProof);
        euint64 finalDepositAmount = _handleDeposit(depositAmount);

        euint64 shares = FHE.div(FHE.mul(finalDepositAmount, ratio), BASE_RATE);
        _deposit(receiver, finalDepositAmount, shares);

        return shares;
    }

    function mintShares(
        address receiver,
        externalEuint64 encryptedSharesAmount,
        bytes calldata inputProof
    ) public virtual onlyOpen returns (euint64) {
        euint64 shares = FHE.fromExternal(encryptedSharesAmount, inputProof);

        euint64 depositAmount = FHE.div(FHE.mul(shares, BASE_RATE), ratio);

        euint64 finalDepositAmount = _handleDeposit(depositAmount);

        euint64 finalShares = FHE.div(FHE.mul(finalDepositAmount, ratio), BASE_RATE);
        _deposit(receiver, finalDepositAmount, finalShares);

        return finalShares;
    }

    function _deposit(address receiver, euint64 finalDepositAmount, euint64 shares) internal virtual {
        FHE.allowTransient(finalDepositAmount, address(cAsset));

        // Perform confidential transfer
        euint64 transferred = ERC7984(cAsset).confidentialTransferFrom(msg.sender, address(this), finalDepositAmount);

        ebool isTransferred = FHE.eq(transferred, finalDepositAmount);

        euint64 mintAmount = FHE.select(isTransferred, shares, FHE.asEuint64(0));

        _mint(receiver, mintAmount);
    }

    function confidentialWithdraw(
        address _receiver,
        externalEuint64 _encryptedAssetsAmount,
        bytes calldata _inputProof
    ) public virtual onlyOpen returns (euint64) {
        euint64 withdrawAmount = FHE.fromExternal(_encryptedAssetsAmount, _inputProof);

        euint64 withdrawShares = FHE.div(FHE.mul(withdrawAmount, ratio), BASE_RATE);
        _withdraw(msg.sender, _receiver, withdrawAmount, withdrawShares);

        return withdrawShares;
    }

    function redeem(
        address _receiver,
        externalEuint64 _encryptedSharesAmount,
        bytes calldata _inputProof
    ) public virtual onlyOpen returns (euint64) {
        euint64 redeemAmount = FHE.fromExternal(_encryptedSharesAmount, _inputProof);

        euint64 withdrawAmount = FHE.div(FHE.mul(redeemAmount, BASE_RATE), ratio);
        _withdraw(msg.sender, _receiver, withdrawAmount, redeemAmount);

        return withdrawAmount;
    }

    function _withdraw(
        address _caller,
        address _receiver,
        euint64 _finalWithdrawAmount,
        euint64 _withdrawShares
    ) internal virtual {
        FHE.allowTransient(_finalWithdrawAmount, address(cAsset));

        // Perform confidential transfer
        euint64 transferred = ERC7984(cAsset).confidentialTransferFrom(address(this), _receiver, _finalWithdrawAmount);

        ebool isTransferred = FHE.eq(transferred, _finalWithdrawAmount);

        euint64 burnAmount = FHE.select(isTransferred, _withdrawShares, FHE.asEuint64(0));

        _burn(_caller, burnAmount);
    }

    function updateSnapshot() external onlyVaultManager {
        // snapshotTotalAssets = totalAssets();
        // snapshotTotalShares = totalShares();

        FHE.allow(totalAssets(), vaultManager);
        FHE.allow(totalShares(), vaultManager);
    }

    function finalizeUpdateRatio(
        uint256 requestId,
        bytes memory abiEncodedCheckResult,
        bytes memory decryptionProof
    ) external virtual {
        // Creating the list of handles in the right order! In this case the order does not matter since the proof
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(requests[requestId].isCorrect);

        FHE.checkSignatures(cts, abiEncodedCheckResult, decryptionProof);
        bool decodedIsCorrect = abi.decode(abiEncodedCheckResult, (bool));
        if (decodedIsCorrect) {
            ratio = requests[requestId].newRatio;
        }
    }

    // rate = Share / Assets
    function requestUpdateRatio(
        uint64 newRatio,
        externalEuint64 inputResidual,
        bytes calldata inputProof
    ) external virtual {
        euint64 residual = FHE.fromExternal(inputResidual, inputProof);

        euint64 _totalShares = totalShares();
        euint64 _totalAssets = totalAssets();

        euint64 calTotalShares = FHE.div(FHE.mul(_totalAssets, newRatio), BASE_RATE);
        calTotalShares = FHE.add(calTotalShares, residual);

        ebool firstCondition = FHE.lt(residual, _totalAssets);
        ebool secondCondition = FHE.eq(calTotalShares, _totalShares);

        // Optimize array creation by using fixed size array
        ebool isCorrect = FHE.and(firstCondition, secondCondition);

        // request decryption if both conditions are true
        FHE.makePubliclyDecryptable(isCorrect);
        requestCounter++;
        requests[requestCounter] = Request(newRatio, isCorrect);

        emit EventRequestUpdateRatio(requestCounter, newRatio);
    }
}
