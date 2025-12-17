// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, externalEuint64, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

contract SwapTokens is ZamaEthereumConfig {
    function swapConfidentialForConfidential(
        IERC7984 fromToken,
        IERC7984 toToken,
        externalEuint64 amountInput,
        bytes calldata inputProof
    ) public virtual {
        require(fromToken.isOperator(msg.sender, address(this)));

        euint64 amount = FHE.fromExternal(amountInput, inputProof);

        FHE.allowTransient(amount, address(fromToken));
        euint64 amountTransferred = fromToken.confidentialTransferFrom(msg.sender, address(this), amount);

        FHE.allowTransient(amountTransferred, address(toToken));
        toToken.confidentialTransfer(msg.sender, amountTransferred);
    }
}
