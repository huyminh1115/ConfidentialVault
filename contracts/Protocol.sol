// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, externalEuint64, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";

contract Protocol is ZamaEthereumConfig {
    uint64 public constant ONE_HUNDRED_PERCENT = 10000; // 100%
    mapping(address allocator => euint64 allocatedAmount) public allocatedAmount;

    function allocatePosition(address token, euint64 amount) public {
        // transfer amount from allocator to protocol
        ERC7984(token).confidentialTransferFrom(msg.sender, address(this), amount);

        allocatedAmount[msg.sender] = FHE.add(allocatedAmount[msg.sender], amount);

        FHE.allowThis(allocatedAmount[msg.sender]);
    }

    function deallocatePosition(address token) public returns (euint64) {
        euint64 amount = allocatedAmount[msg.sender];

        FHE.allowTransient(amount, token);
        ERC7984(token).confidentialTransfer(msg.sender, amount);

        allocatedAmount[msg.sender] = FHE.asEuint64(0);

        return amount;
    }

    function getAllocatedAmount() public view returns (euint64) {
        return allocatedAmount[msg.sender];
    }

    function increaseAllocatedAmount(address allocator, externalEuint64 amount, bytes calldata inputProof) public {
        euint64 _amount = FHE.fromExternal(amount, inputProof);
        allocatedAmount[allocator] = FHE.add(allocatedAmount[allocator], _amount);

        FHE.allowThis(allocatedAmount[allocator]);
    }

    function decreaseAllocatedAmount(address allocator, externalEuint64 amount, bytes calldata inputProof) public {
        euint64 _amount = FHE.fromExternal(amount, inputProof);
        (ebool isSuccess, euint64 updated) = FHESafeMath.tryDecrease(allocatedAmount[allocator], _amount);

        allocatedAmount[allocator] = updated;

        FHE.allowThis(allocatedAmount[allocator]);
    }
}
