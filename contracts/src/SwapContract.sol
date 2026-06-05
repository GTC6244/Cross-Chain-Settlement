// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title SwapContract
 * @notice On-chain source of truth for cross-chain swaps via Lit Actions.
 *         Each swap has a unique Lit Action (IPFS CID) that controls
 *         deterministic deposit addresses across chains.
 *
 *         Two-sided market model:
 *         - A user announces an *intent* off the settlement path via
 *           `announceIntent` (a stateless event, no escrow). Solvers read the
 *           `IntentAnnounced` log as an order book.
 *         - A solver fills an intent by calling `createSwap` with the real
 *           `destAmount` (>= the user's `minDestAmount` floor) and the four
 *           role addresses. The settlement state machine
 *           (Created -> Executed | Refunded) is unchanged.
 *
 *         FOUR-ADDRESS MODEL (settlement and refund use different chains, so
 *         two address slots are not enough for a genuine two-party swap):
 *
 *             success (settle)         failure (refund)
 *           source asset -> solverReceiveSource    userRefundSource
 *           dest   asset -> userReceiveDest        solverRefundDest
 *
 *         The user provides userRefundSource (source chain) + userReceiveDest
 *         (dest chain) in the intent; the solver provides solverReceiveSource
 *         (source chain) + solverRefundDest (dest chain) at createSwap.
 */
contract SwapContract {
    enum SwapState { Created, Funded, Executed, Refunded, Expired }
    enum FeeModel { RearLoaded }

    struct Swap {
        // Chain identifiers (e.g., "base-sepolia", "bitcoin-signet")
        string sourceChain;
        string destChain;

        // Amounts in smallest unit (wei, satoshi, zatoshi)
        uint256 sourceAmount;
        uint256 destAmount;
        // Floor the solver's destAmount had to meet (the user's intent minimum)
        uint256 minDestAmount;

        // Four role-based addresses (chain-specific format, stored as strings).
        // See the FOUR-ADDRESS MODEL diagram above.
        string userRefundSource;    // user, source chain  — refund of input on failure
        string userReceiveDest;     // user, dest chain    — receives dest asset on success
        string solverReceiveSource; // solver, source chain — receives source asset on success
        string solverRefundDest;    // solver, dest chain  — refund of dest deposit on failure

        // Deposit addresses derived from Lit Action key
        string depositAddressSource;
        string depositAddressDest;

        // Timing
        uint256 confirmationBlocks;
        uint256 expirationTimestamp;

        // Fees
        uint16 feeBps; // 0-10000 (0-100%)
        FeeModel feeModel;

        // Lit Action
        string litActionCid;
        // The salt that produced the CID — emitted + stored so the user app can
        // recompute and verify the CID against the audited template.
        string salt;

        // Links this swap back to the user's announced intent (order book join key)
        bytes32 intentId;

        // State
        SwapState state;
        address creator;
        uint256 createdAt;

        // The EVM address derived from the Lit Action's key
        // Used to restrict who can call markExecuted/markRefunded
        address litActionEvmAddress;

        // ERC-20 token addresses (address(0) = native token)
        address tokenAddressSource;
        address tokenAddressDest;

        // Per-leg settlement tracking (enables idempotent re-execution)
        bool sourceLegSettled;
        bool destLegSettled;
        string sourceLegTxHash;  // chain-specific tx hash for source leg
        string destLegTxHash;    // chain-specific tx hash for dest leg

        // Fee settlement tracking (separate from legs so a crash between a leg
        // settling and the fee being paid is recoverable on re-execution).
        bool feeSettled;
        string feeTxHash;
    }

    address public owner;
    uint256 public swapCount;
    mapping(uint256 => Swap) public swaps;

    /**
     * @notice A user's swap intent, broadcast for solvers to fill. Carries no
     *         on-chain state and moves no funds — it is purely an order-book
     *         beacon. `msg.sender` (indexed `creator`) authenticates the user,
     *         so no separate signature layer is needed.
     */
    event IntentAnnounced(
        bytes32 indexed intentId,
        address indexed creator,
        string sourceChain,
        string destChain,
        uint256 sourceAmount,
        uint256 minDestAmount,
        uint256 expiration,
        uint16 feeBps,
        address tokenSource,
        address tokenDest,
        string userRefundSource,
        string userReceiveDest
    );

    event SwapCreated(
        uint256 indexed swapId,
        bytes32 indexed intentId,
        string sourceChain,
        string destChain,
        uint256 sourceAmount,
        uint256 destAmount,
        uint256 minDestAmount,
        string litActionCid,
        string salt,
        address creator
    );
    event SwapExecuted(uint256 indexed swapId);
    event SwapRefunded(uint256 indexed swapId);
    event SwapExpired(uint256 indexed swapId);
    event LegSettled(uint256 indexed swapId, bool isSourceLeg, string txHash);
    event FeeSettled(uint256 indexed swapId, string txHash);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyLitAction(uint256 swapId) {
        require(
            msg.sender == swaps[swapId].litActionEvmAddress,
            "not lit action"
        );
        _;
    }

    modifier inState(uint256 swapId, SwapState expected) {
        require(swaps[swapId].state == expected, "invalid state");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Announce a swap intent for solvers to discover and fill. Emits an
     *         event only — no storage write, no state, no escrow. The basic
     *         sanity checks keep obviously-invalid intents out of the order book.
     * @param intentId Client-generated id (links to the resulting swap)
     * @param sourceChain Chain the user will send from
     * @param destChain Chain the user wants to receive on
     * @param sourceAmount Amount the user will provide (smallest unit)
     * @param minDestAmount Minimum the user will accept on dest (the floor)
     * @param expiration Unix timestamp after which the intent is stale
     * @param feeBps Fee in basis points (0-10000)
     * @param tokenSource ERC-20 on source (address(0) = native)
     * @param tokenDest ERC-20 on dest (address(0) = native)
     * @param userRefundSource User's source-chain address (refund on failure)
     * @param userReceiveDest User's dest-chain address (receives on success)
     */
    function announceIntent(
        bytes32 intentId,
        string calldata sourceChain,
        string calldata destChain,
        uint256 sourceAmount,
        uint256 minDestAmount,
        uint256 expiration,
        uint16 feeBps,
        address tokenSource,
        address tokenDest,
        string calldata userRefundSource,
        string calldata userReceiveDest
    ) external {
        require(sourceAmount > 0, "source amount zero");
        require(minDestAmount > 0, "min dest zero");
        require(expiration > block.timestamp, "already expired");
        require(feeBps <= 10000, "fee too high");

        emit IntentAnnounced(
            intentId,
            msg.sender,
            sourceChain,
            destChain,
            sourceAmount,
            minDestAmount,
            expiration,
            feeBps,
            tokenSource,
            tokenDest,
            userRefundSource,
            userReceiveDest
        );
    }

    /**
     * @notice Create a new swap record. In the two-sided model this is called
     *         by a solver filling an announced intent: it supplies the real
     *         `destAmount` (>= `minDestAmount`) and the four role addresses.
     * @param intentId The announced intent this swap fills (0x0 if direct)
     * @param sourceChain Chain identifier for source (e.g., "base-sepolia")
     * @param destChain Chain identifier for destination (e.g., "bitcoin-signet")
     * @param sourceAmount Amount expected on source chain (smallest unit)
     * @param destAmount Amount expected on destination chain (smallest unit)
     * @param minDestAmount Floor from the intent; destAmount must be >= this
     * @param userRefundSource User's source-chain refund address
     * @param userReceiveDest User's dest-chain receive address
     * @param solverReceiveSource Solver's source-chain receive address
     * @param solverRefundDest Solver's dest-chain refund address
     * @param depositAddressSource Deposit address on source chain (from Lit key)
     * @param depositAddressDest Deposit address on destination chain (from Lit key)
     * @param confirmationBlocks Required block confirmations before execution
     * @param expirationTimestamp Unix timestamp after which swap can be refunded
     * @param feeBps Fee in basis points (0-10000)
     * @param litActionCid IPFS CID of the Lit Action for this swap
     * @param salt Salt that produced the CID (emitted + stored for CID verify)
     * @param litActionEvmAddress EVM address derived from the Lit Action's key
     * @param tokenAddressSource ERC-20 token on source chain (address(0) = native)
     * @param tokenAddressDest ERC-20 token on dest chain (address(0) = native)
     */
    function createSwap(
        bytes32 intentId,
        string calldata sourceChain,
        string calldata destChain,
        uint256 sourceAmount,
        uint256 destAmount,
        uint256 minDestAmount,
        string calldata userRefundSource,
        string calldata userReceiveDest,
        string calldata solverReceiveSource,
        string calldata solverRefundDest,
        string calldata depositAddressSource,
        string calldata depositAddressDest,
        uint256 confirmationBlocks,
        uint256 expirationTimestamp,
        uint16 feeBps,
        string calldata litActionCid,
        string calldata salt,
        address litActionEvmAddress,
        address tokenAddressSource,
        address tokenAddressDest
    ) external returns (uint256 swapId) {
        require(sourceAmount > 0, "source amount zero");
        require(destAmount > 0, "dest amount zero");
        require(minDestAmount > 0, "min dest zero");
        require(destAmount >= minDestAmount, "below floor");
        require(expirationTimestamp > block.timestamp, "already expired");
        require(feeBps <= 10000, "fee too high");
        require(litActionEvmAddress != address(0), "zero lit action address");

        swapId = swapCount++;

        Swap storage s = swaps[swapId];
        s.sourceChain = sourceChain;
        s.destChain = destChain;
        s.sourceAmount = sourceAmount;
        s.destAmount = destAmount;
        s.minDestAmount = minDestAmount;
        s.userRefundSource = userRefundSource;
        s.userReceiveDest = userReceiveDest;
        s.solverReceiveSource = solverReceiveSource;
        s.solverRefundDest = solverRefundDest;
        s.depositAddressSource = depositAddressSource;
        s.depositAddressDest = depositAddressDest;
        s.confirmationBlocks = confirmationBlocks;
        s.expirationTimestamp = expirationTimestamp;
        s.feeBps = feeBps;
        s.feeModel = FeeModel.RearLoaded;
        s.litActionCid = litActionCid;
        s.salt = salt;
        s.intentId = intentId;
        s.state = SwapState.Created;
        s.creator = msg.sender;
        s.createdAt = block.timestamp;
        s.litActionEvmAddress = litActionEvmAddress;
        s.tokenAddressSource = tokenAddressSource;
        s.tokenAddressDest = tokenAddressDest;

        emit SwapCreated(
            swapId,
            intentId,
            sourceChain,
            destChain,
            sourceAmount,
            destAmount,
            minDestAmount,
            litActionCid,
            salt,
            msg.sender
        );
    }

    /**
     * @notice Record that one leg of the swap has been settled.
     *         Called by the Lit Action after each successful transfer.
     *         Enables idempotent re-execution: on retry, the action
     *         checks which legs are done and only settles the remainder.
     * @param swapId The swap ID
     * @param isSourceLeg true = source chain leg, false = dest chain leg
     * @param txHash The chain-specific transaction hash (for auditability)
     */
    function markLegSettled(uint256 swapId, bool isSourceLeg, string calldata txHash)
        external
        onlyLitAction(swapId)
        inState(swapId, SwapState.Created)
    {
        Swap storage s = swaps[swapId];
        if (isSourceLeg) {
            require(!s.sourceLegSettled, "source leg already settled");
            s.sourceLegSettled = true;
            s.sourceLegTxHash = txHash;
        } else {
            require(!s.destLegSettled, "dest leg already settled");
            s.destLegSettled = true;
            s.destLegTxHash = txHash;
        }
        emit LegSettled(swapId, isSourceLeg, txHash);
    }

    /**
     * @notice Record that the fee has been paid to the owner. Tracked
     *         separately from the legs so a crash between a leg settling and the
     *         fee transfer is recoverable: on re-execution the action checks
     *         this flag and only re-sends the fee if it wasn't recorded.
     * @param swapId The swap ID
     * @param txHash The fee transfer tx hash (for auditability)
     */
    function markFeeSettled(uint256 swapId, string calldata txHash)
        external
        onlyLitAction(swapId)
        inState(swapId, SwapState.Created)
    {
        Swap storage s = swaps[swapId];
        require(!s.feeSettled, "fee already settled");
        s.feeSettled = true;
        s.feeTxHash = txHash;
        emit FeeSettled(swapId, txHash);
    }

    /**
     * @notice Mark a swap as fully executed. Requires both legs settled.
     *         Called by the Lit Action after both transfers complete.
     */
    function markExecuted(uint256 swapId)
        external
        onlyLitAction(swapId)
        inState(swapId, SwapState.Created)
    {
        require(swaps[swapId].sourceLegSettled, "source leg not settled");
        require(swaps[swapId].destLegSettled, "dest leg not settled");
        swaps[swapId].state = SwapState.Executed;
        emit SwapExecuted(swapId);
    }

    /**
     * @notice Mark a swap as refunded (called by the Lit Action after refund)
     */
    function markRefunded(uint256 swapId)
        external
        onlyLitAction(swapId)
        inState(swapId, SwapState.Created)
    {
        swaps[swapId].state = SwapState.Refunded;
        emit SwapRefunded(swapId);
    }

    /**
     * @notice Get swap state and key fields
     */
    function getSwapState(uint256 swapId) external view returns (
        SwapState state,
        address creator,
        address litActionEvmAddress,
        uint256 sourceAmount,
        uint256 destAmount,
        uint16 feeBps,
        uint256 expirationTimestamp,
        string memory litActionCid
    ) {
        Swap storage s = swaps[swapId];
        return (
            s.state,
            s.creator,
            s.litActionEvmAddress,
            s.sourceAmount,
            s.destAmount,
            s.feeBps,
            s.expirationTimestamp,
            s.litActionCid
        );
    }

    /**
     * @notice Get swap chain and address details.
     *         Returns the four role addresses (see FOUR-ADDRESS MODEL) followed
     *         by the two deposit addresses and confirmation blocks. The off-chain
     *         engine decodes these positionally — keep the order in sync.
     */
    function getSwapAddresses(uint256 swapId) external view returns (
        string memory sourceChain,
        string memory destChain,
        string memory userRefundSource,
        string memory userReceiveDest,
        string memory solverReceiveSource,
        string memory solverRefundDest,
        string memory depositAddressSource,
        string memory depositAddressDest,
        uint256 confirmationBlocks
    ) {
        Swap storage s = swaps[swapId];
        return (
            s.sourceChain,
            s.destChain,
            s.userRefundSource,
            s.userReceiveDest,
            s.solverReceiveSource,
            s.solverRefundDest,
            s.depositAddressSource,
            s.depositAddressDest,
            s.confirmationBlocks
        );
    }

    /**
     * @notice Get the intent linkage, dest-amount floor, and CID salt for a swap.
     *         The engine reads `minDestAmount` to assert the settled `destAmount`
     *         honored the floor; the user app reads `salt` to verify the CID.
     */
    function getSwapIntent(uint256 swapId) external view returns (
        bytes32 intentId,
        uint256 minDestAmount,
        string memory salt
    ) {
        Swap storage s = swaps[swapId];
        return (s.intentId, s.minDestAmount, s.salt);
    }

    /**
     * @notice Get per-leg settlement status
     */
    function getSwapLegs(uint256 swapId) external view returns (
        bool sourceLegSettled,
        bool destLegSettled,
        string memory sourceLegTxHash,
        string memory destLegTxHash
    ) {
        Swap storage s = swaps[swapId];
        return (
            s.sourceLegSettled,
            s.destLegSettled,
            s.sourceLegTxHash,
            s.destLegTxHash
        );
    }

    /**
     * @notice Get fee settlement status (for idempotent fee recovery)
     */
    function getFeeStatus(uint256 swapId) external view returns (
        bool feeSettled,
        string memory feeTxHash
    ) {
        Swap storage s = swaps[swapId];
        return (s.feeSettled, s.feeTxHash);
    }

    /**
     * @notice Get token addresses for a swap
     */
    function getSwapTokens(uint256 swapId) external view returns (
        address tokenAddressSource,
        address tokenAddressDest
    ) {
        Swap storage s = swaps[swapId];
        return (s.tokenAddressSource, s.tokenAddressDest);
    }

    /**
     * @notice Transfer contract ownership
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }
}
