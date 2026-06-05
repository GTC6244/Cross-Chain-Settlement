// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {SwapContract} from "../src/SwapContract.sol";

contract SwapContractTest is Test {
    SwapContract public swap;
    address public owner = address(this);
    address public litActionAddr = address(0x1234567890AbcdEF1234567890aBcdef12345678);
    address public alice = address(0xA11CE);
    address public usdc = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);

    bytes32 public constant INTENT_ID = bytes32(uint256(0xABC));

    // Four role addresses (see FOUR-ADDRESS MODEL in SwapContract.sol)
    string constant USER_REFUND_SRC = "0xUserRefundSrc";
    string constant USER_RECV_DEST = "tb1qUserReceiveDest";
    string constant SOLVER_RECV_SRC = "0xSolverReceiveSrc";
    string constant SOLVER_REFUND_DEST = "tb1qSolverRefundDest";

    function setUp() public {
        swap = new SwapContract();
    }

    // Happy-path swap with descriptive addresses (used by mapping/round-trip tests).
    function _createTestSwap() internal returns (uint256) {
        return swap.createSwap(
            INTENT_ID,
            "base-sepolia",
            "bitcoin-signet",
            1 ether,
            100000,
            100000, // minDestAmount == destAmount (floor satisfied)
            USER_REFUND_SRC,
            USER_RECV_DEST,
            SOLVER_RECV_SRC,
            SOLVER_REFUND_DEST,
            "0xDepositSource",
            "tb1qDepositDest",
            1,
            block.timestamp + 1 hours,
            50,
            "QmTestCid123",
            "saltcafe01",
            litActionAddr,
            address(0),
            address(0)
        );
    }

    // Compact builder for the validation/revert tests — varies only the fields
    // those tests exercise, defaults the rest to valid values.
    function _create(
        uint256 sourceAmount,
        uint256 destAmount,
        uint256 minDestAmount,
        uint256 expiration,
        uint16 feeBps,
        address litAddr
    ) internal returns (uint256) {
        return swap.createSwap(
            INTENT_ID,
            "a", "b",
            sourceAmount, destAmount, minDestAmount,
            "ur", "ud", "sr", "sd",
            "ds", "dd",
            1, expiration, feeBps,
            "cid", "salt", litAddr,
            address(0), address(0)
        );
    }

    // Helper: settle both legs for a swap
    function _settleBothLegs(uint256 swapId) internal {
        vm.startPrank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xSourceTxHash");
        swap.markLegSettled(swapId, false, "0xDestTxHash");
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // announceIntent (stateless order-book beacon)
    // -----------------------------------------------------------------------

    function test_announceIntent_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit SwapContract.IntentAnnounced(
            INTENT_ID, owner, "base-sepolia", "bitcoin-signet",
            1 ether, 100000, block.timestamp + 1 hours, 50,
            address(0), address(0), USER_REFUND_SRC, USER_RECV_DEST
        );
        swap.announceIntent(
            INTENT_ID, "base-sepolia", "bitcoin-signet",
            1 ether, 100000, block.timestamp + 1 hours, 50,
            address(0), address(0), USER_REFUND_SRC, USER_RECV_DEST
        );
    }

    function test_announceIntent_writesNoStorage() public {
        // Announcing must not create a swap record.
        swap.announceIntent(
            INTENT_ID, "a", "b", 1 ether, 100000, block.timestamp + 1 hours, 50,
            address(0), address(0), USER_REFUND_SRC, USER_RECV_DEST
        );
        assertEq(swap.swapCount(), 0);
    }

    function test_announceIntent_authenticatesSender() public {
        // The emitted creator is msg.sender, not a passed-in field.
        vm.expectEmit(true, true, false, true);
        emit SwapContract.IntentAnnounced(
            INTENT_ID, alice, "a", "b", 1 ether, 100000, block.timestamp + 1 hours, 50,
            address(0), address(0), USER_REFUND_SRC, USER_RECV_DEST
        );
        vm.prank(alice);
        swap.announceIntent(
            INTENT_ID, "a", "b", 1 ether, 100000, block.timestamp + 1 hours, 50,
            address(0), address(0), USER_REFUND_SRC, USER_RECV_DEST
        );
    }

    function test_announceIntent_revert_zeroSourceAmount() public {
        vm.expectRevert("source amount zero");
        swap.announceIntent(INTENT_ID, "a", "b", 0, 1, block.timestamp + 1, 50, address(0), address(0), "u", "d");
    }

    function test_announceIntent_revert_zeroMinDest() public {
        vm.expectRevert("min dest zero");
        swap.announceIntent(INTENT_ID, "a", "b", 1, 0, block.timestamp + 1, 50, address(0), address(0), "u", "d");
    }

    function test_announceIntent_revert_expired() public {
        vm.expectRevert("already expired");
        swap.announceIntent(INTENT_ID, "a", "b", 1, 1, block.timestamp - 1, 50, address(0), address(0), "u", "d");
    }

    function test_announceIntent_revert_feeTooHigh() public {
        vm.expectRevert("fee too high");
        swap.announceIntent(INTENT_ID, "a", "b", 1, 1, block.timestamp + 1, 10001, address(0), address(0), "u", "d");
    }

    // -----------------------------------------------------------------------
    // createSwap
    // -----------------------------------------------------------------------

    function test_createSwap() public {
        uint256 swapId = _createTestSwap();
        assertEq(swapId, 0);
        assertEq(swap.swapCount(), 1);

        (
            SwapContract.SwapState state,
            address creator,
            address litAddr,
            uint256 sourceAmount,
            uint256 destAmount,
            uint16 feeBps,
            uint256 expirationTimestamp,
            string memory litActionCid
        ) = swap.getSwapState(swapId);

        (
            string memory sourceChain,
            string memory destChain,
            , , , , , ,
            uint256 confirmationBlocks
        ) = swap.getSwapAddresses(swapId);

        assertEq(sourceChain, "base-sepolia");
        assertEq(destChain, "bitcoin-signet");
        assertEq(sourceAmount, 1 ether);
        assertEq(destAmount, 100000);
        assertEq(confirmationBlocks, 1);
        assertEq(feeBps, 50);
        assertEq(litActionCid, "QmTestCid123");
        assertEq(uint8(state), uint8(SwapContract.SwapState.Created));
        assertEq(creator, owner);
        assertEq(litAddr, litActionAddr);
        assertTrue(expirationTimestamp > block.timestamp);
    }

    // F1: the four role addresses must round-trip in the correct slots. A
    // positional-decode slip here is the class of bug that sends funds to the
    // wrong chain — this test is the guardrail for it.
    function test_createSwap_fourAddressesRoundTrip() public {
        uint256 swapId = _createTestSwap();
        (
            , , // sourceChain, destChain
            string memory userRefundSource,
            string memory userReceiveDest,
            string memory solverReceiveSource,
            string memory solverRefundDest,
            string memory depositAddressSource,
            string memory depositAddressDest,
            // confirmationBlocks
        ) = swap.getSwapAddresses(swapId);

        assertEq(userRefundSource, USER_REFUND_SRC);
        assertEq(userReceiveDest, USER_RECV_DEST);
        assertEq(solverReceiveSource, SOLVER_RECV_SRC);
        assertEq(solverRefundDest, SOLVER_REFUND_DEST);
        assertEq(depositAddressSource, "0xDepositSource");
        assertEq(depositAddressDest, "tb1qDepositDest");
    }

    function test_createSwap_storesIntentAndFloor() public {
        uint256 swapId = _createTestSwap();
        (bytes32 intentId, uint256 minDestAmount, string memory salt) = swap.getSwapIntent(swapId);
        assertEq(intentId, INTENT_ID);
        assertEq(minDestAmount, 100000);
        assertEq(salt, "saltcafe01");
    }

    function test_createSwap_legsInitiallyUnsettled() public {
        uint256 swapId = _createTestSwap();
        (bool srcSettled, bool dstSettled, string memory srcTx, string memory dstTx) = swap.getSwapLegs(swapId);
        assertFalse(srcSettled);
        assertFalse(dstSettled);
        assertEq(bytes(srcTx).length, 0);
        assertEq(bytes(dstTx).length, 0);
    }

    function test_createSwap_nativeTokens() public {
        uint256 swapId = _createTestSwap();
        (address tokenSrc, address tokenDst) = swap.getSwapTokens(swapId);
        assertEq(tokenSrc, address(0));
        assertEq(tokenDst, address(0));
    }

    function test_createSwap_erc20Tokens() public {
        uint256 swapId = swap.createSwap(
            INTENT_ID, "base-sepolia", "ethereum-sepolia", 1000000, 1000000, 1000000,
            "ur", "ud", "sr", "sd", "0xDepositSource", "0xDepositDest",
            1, block.timestamp + 1 hours, 50, "QmErc20Cid", "salt", litActionAddr,
            usdc, usdc
        );
        (address tokenSrc, address tokenDst) = swap.getSwapTokens(swapId);
        assertEq(tokenSrc, usdc);
        assertEq(tokenDst, usdc);
    }

    function test_createSwap_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit SwapContract.SwapCreated(
            0, INTENT_ID, "base-sepolia", "bitcoin-signet",
            1 ether, 100000, 100000, "QmTestCid123", "saltcafe01", owner
        );
        _createTestSwap();
    }

    function test_createSwap_incrementsId() public {
        uint256 id0 = _createTestSwap();
        uint256 id1 = _createTestSwap();
        assertEq(id0, 0);
        assertEq(id1, 1);
        assertEq(swap.swapCount(), 2);
    }

    function test_createSwap_revert_zeroSourceAmount() public {
        vm.expectRevert("source amount zero");
        _create(0, 1, 1, block.timestamp + 1, 50, litActionAddr);
    }

    function test_createSwap_revert_zeroDestAmount() public {
        vm.expectRevert("dest amount zero");
        _create(1, 0, 1, block.timestamp + 1, 50, litActionAddr);
    }

    function test_createSwap_revert_zeroMinDest() public {
        vm.expectRevert("min dest zero");
        _create(1, 1, 0, block.timestamp + 1, 50, litActionAddr);
    }

    // The solver cannot fill below the user's floor.
    function test_createSwap_revert_belowFloor() public {
        vm.expectRevert("below floor");
        _create(1 ether, 99999, 100000, block.timestamp + 1, 50, litActionAddr);
    }

    function test_createSwap_revert_expired() public {
        vm.expectRevert("already expired");
        _create(1, 1, 1, block.timestamp - 1, 50, litActionAddr);
    }

    function test_createSwap_revert_feeTooHigh() public {
        vm.expectRevert("fee too high");
        _create(1, 1, 1, block.timestamp + 1, 10001, litActionAddr);
    }

    function test_createSwap_revert_zeroLitAddr() public {
        vm.expectRevert("zero lit action address");
        _create(1, 1, 1, block.timestamp + 1, 50, address(0));
    }

    // -----------------------------------------------------------------------
    // markLegSettled
    // -----------------------------------------------------------------------

    function test_markLegSettled_source() public {
        uint256 swapId = _createTestSwap();
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xabc123");

        (bool srcSettled, bool dstSettled, string memory srcTx, string memory dstTx) = swap.getSwapLegs(swapId);
        assertTrue(srcSettled);
        assertFalse(dstSettled);
        assertEq(srcTx, "0xabc123");
        assertEq(bytes(dstTx).length, 0);
    }

    function test_markLegSettled_dest() public {
        uint256 swapId = _createTestSwap();
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, false, "0xdef456");

        (bool srcSettled, bool dstSettled,, string memory dstTx) = swap.getSwapLegs(swapId);
        assertFalse(srcSettled);
        assertTrue(dstSettled);
        assertEq(dstTx, "0xdef456");
    }

    function test_markLegSettled_bothLegs() public {
        uint256 swapId = _createTestSwap();
        _settleBothLegs(swapId);

        (bool srcSettled, bool dstSettled, string memory srcTx, string memory dstTx) = swap.getSwapLegs(swapId);
        assertTrue(srcSettled);
        assertTrue(dstSettled);
        assertEq(srcTx, "0xSourceTxHash");
        assertEq(dstTx, "0xDestTxHash");
    }

    function test_markLegSettled_emitsEvent() public {
        uint256 swapId = _createTestSwap();
        vm.expectEmit(true, false, false, true);
        emit SwapContract.LegSettled(swapId, true, "0xabc");
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xabc");
    }

    // -----------------------------------------------------------------------
    // markFeeSettled
    // -----------------------------------------------------------------------

    function test_markFeeSettled() public {
        uint256 swapId = _createTestSwap();
        (bool before,) = swap.getFeeStatus(swapId);
        assertFalse(before);

        vm.prank(litActionAddr);
        swap.markFeeSettled(swapId, "0xFeeTx");

        (bool settled, string memory feeTx) = swap.getFeeStatus(swapId);
        assertTrue(settled);
        assertEq(feeTx, "0xFeeTx");
    }

    function test_markFeeSettled_revert_alreadySettled() public {
        uint256 swapId = _createTestSwap();
        vm.startPrank(litActionAddr);
        swap.markFeeSettled(swapId, "0xFeeTx");
        vm.expectRevert("fee already settled");
        swap.markFeeSettled(swapId, "0xFeeTx2");
        vm.stopPrank();
    }

    function test_markFeeSettled_revert_notLitAction() public {
        uint256 swapId = _createTestSwap();
        vm.prank(alice);
        vm.expectRevert("not lit action");
        swap.markFeeSettled(swapId, "0xFeeTx");
    }

    function test_markFeeSettled_emitsEvent() public {
        uint256 swapId = _createTestSwap();
        vm.expectEmit(true, false, false, true);
        emit SwapContract.FeeSettled(swapId, "0xFeeTx");
        vm.prank(litActionAddr);
        swap.markFeeSettled(swapId, "0xFeeTx");
    }

    function test_markLegSettled_revert_notLitAction() public {
        uint256 swapId = _createTestSwap();
        vm.prank(alice);
        vm.expectRevert("not lit action");
        swap.markLegSettled(swapId, true, "0xabc");
    }

    function test_markLegSettled_revert_alreadySettled_source() public {
        uint256 swapId = _createTestSwap();
        vm.startPrank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xfirst");
        vm.expectRevert("source leg already settled");
        swap.markLegSettled(swapId, true, "0xsecond");
        vm.stopPrank();
    }

    function test_markLegSettled_revert_alreadySettled_dest() public {
        uint256 swapId = _createTestSwap();
        vm.startPrank(litActionAddr);
        swap.markLegSettled(swapId, false, "0xfirst");
        vm.expectRevert("dest leg already settled");
        swap.markLegSettled(swapId, false, "0xsecond");
        vm.stopPrank();
    }

    function test_markLegSettled_revert_wrongState() public {
        uint256 swapId = _createTestSwap();
        // Execute the swap first
        _settleBothLegs(swapId);
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
        // Now try to settle a leg on an executed swap
        vm.prank(litActionAddr);
        vm.expectRevert("invalid state");
        swap.markLegSettled(swapId, true, "0xlate");
    }

    // -----------------------------------------------------------------------
    // markExecuted (now requires both legs)
    // -----------------------------------------------------------------------

    function test_markExecuted_afterBothLegs() public {
        uint256 swapId = _createTestSwap();
        _settleBothLegs(swapId);

        vm.prank(litActionAddr);
        swap.markExecuted(swapId);

        (SwapContract.SwapState state,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state), uint8(SwapContract.SwapState.Executed));
    }

    function test_markExecuted_emitsEvent() public {
        uint256 swapId = _createTestSwap();
        _settleBothLegs(swapId);

        vm.expectEmit(true, false, false, false);
        emit SwapContract.SwapExecuted(swapId);
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_sourceLegNotSettled() public {
        uint256 swapId = _createTestSwap();
        // Only settle dest leg
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, false, "0xdest");

        vm.prank(litActionAddr);
        vm.expectRevert("source leg not settled");
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_destLegNotSettled() public {
        uint256 swapId = _createTestSwap();
        // Only settle source leg
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xsrc");

        vm.prank(litActionAddr);
        vm.expectRevert("dest leg not settled");
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_noLegsSettled() public {
        uint256 swapId = _createTestSwap();
        vm.prank(litActionAddr);
        vm.expectRevert("source leg not settled");
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_notLitAction() public {
        uint256 swapId = _createTestSwap();
        _settleBothLegs(swapId);
        vm.prank(alice);
        vm.expectRevert("not lit action");
        swap.markExecuted(swapId);
    }

    function test_markExecuted_revert_wrongState() public {
        uint256 swapId = _createTestSwap();
        _settleBothLegs(swapId);
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
        // Try again
        vm.prank(litActionAddr);
        vm.expectRevert("invalid state");
        swap.markExecuted(swapId);
    }

    // -----------------------------------------------------------------------
    // markRefunded
    // -----------------------------------------------------------------------

    function test_markRefunded() public {
        uint256 swapId = _createTestSwap();
        vm.prank(litActionAddr);
        swap.markRefunded(swapId);
        (SwapContract.SwapState state,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state), uint8(SwapContract.SwapState.Refunded));
    }

    function test_markRefunded_revert_notLitAction() public {
        uint256 swapId = _createTestSwap();
        vm.prank(alice);
        vm.expectRevert("not lit action");
        swap.markRefunded(swapId);
    }

    // Refund allowed even with one leg settled (partial settlement recovery)
    function test_markRefunded_afterPartialSettlement() public {
        uint256 swapId = _createTestSwap();
        vm.startPrank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xsource");
        swap.markRefunded(swapId);
        vm.stopPrank();

        (SwapContract.SwapState state,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state), uint8(SwapContract.SwapState.Refunded));
    }

    // -----------------------------------------------------------------------
    // Ownership
    // -----------------------------------------------------------------------

    function test_transferOwnership() public {
        swap.transferOwnership(alice);
        assertEq(swap.owner(), alice);
    }

    function test_transferOwnership_revert_notOwner() public {
        vm.prank(alice);
        vm.expectRevert("not owner");
        swap.transferOwnership(alice);
    }

    function test_transferOwnership_revert_zeroAddress() public {
        vm.expectRevert("zero address");
        swap.transferOwnership(address(0));
    }

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    function test_maxFee() public {
        _create(1, 1, 1, block.timestamp + 1, 10000, litActionAddr);
    }

    // destAmount exactly at the floor is allowed.
    function test_createSwap_destAmountEqualsFloor() public {
        uint256 swapId = _create(1 ether, 100000, 100000, block.timestamp + 1 hours, 50, litActionAddr);
        (, uint256 minDestAmount,) = swap.getSwapIntent(swapId);
        assertEq(minDestAmount, 100000);
    }

    function test_mixedTokenSwap() public {
        uint256 swapId = swap.createSwap(
            INTENT_ID, "base-sepolia", "ethereum-sepolia", 1000000, 1 ether, 1 ether,
            "ur", "ud", "sr", "sd", "0xDep", "0xDep",
            1, block.timestamp + 1 hours, 100, "QmMixed", "salt", litActionAddr,
            usdc, address(0)
        );
        (address tokenSrc, address tokenDst) = swap.getSwapTokens(swapId);
        assertEq(tokenSrc, usdc);
        assertEq(tokenDst, address(0));
    }

    // Full lifecycle: announce -> create -> settle source -> settle dest -> execute
    function test_fullLifecycle() public {
        // User announces (order-book beacon, no state)
        swap.announceIntent(
            INTENT_ID, "base-sepolia", "bitcoin-signet", 1 ether, 100000,
            block.timestamp + 1 hours, 50, address(0), address(0), USER_REFUND_SRC, USER_RECV_DEST
        );
        assertEq(swap.swapCount(), 0);

        // Solver fills it
        uint256 swapId = _createTestSwap();

        // Initially Created, no legs settled
        (SwapContract.SwapState state0,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state0), uint8(SwapContract.SwapState.Created));

        // Settle source leg
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, true, "0xbtc-txid-abc");
        (bool src1, bool dst1,,) = swap.getSwapLegs(swapId);
        assertTrue(src1);
        assertFalse(dst1);

        // Still in Created state
        (SwapContract.SwapState state1,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state1), uint8(SwapContract.SwapState.Created));

        // Settle dest leg
        vm.prank(litActionAddr);
        swap.markLegSettled(swapId, false, "0xeth-txhash-def");
        (bool src2, bool dst2,,) = swap.getSwapLegs(swapId);
        assertTrue(src2);
        assertTrue(dst2);

        // Mark executed
        vm.prank(litActionAddr);
        swap.markExecuted(swapId);
        (SwapContract.SwapState state2,,,,,,,) = swap.getSwapState(swapId);
        assertEq(uint8(state2), uint8(SwapContract.SwapState.Executed));
    }
}
