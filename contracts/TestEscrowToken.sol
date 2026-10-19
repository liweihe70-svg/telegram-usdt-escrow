// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts@5.4.0/token/ERC20/ERC20.sol";

/// @notice Test fixture token only. Not USDT; no monetary value.
contract TestEscrowToken is ERC20 {
    constructor() ERC20("Escrow Test Token", "TESTUSD") {
        require(block.chainid == 97, "BNB_TESTNET_ONLY");
        _mint(msg.sender, 1_000_000 * 10 ** 18);
    }
}
