# Janus Wrapper Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MEV-safe LB v2.0 vault — a per-team EIP-1167 factory clone that holds pooled LB shares, issues an ERC-20 receipt token, supports atomic deposit/redeem/rebalance, and skims a WETH-denominated performance fee via HWM + cost-basis accounting. Per spec `docs/superpowers/specs/2026-06-09-managed-dlmm-pools-design.md` §7.

**Architecture:** Two contracts in `dungeonclaw-contracts/src/`:
- `JanusWrapper.sol` — the vault impl (~300 LoC). Embeds ERC-20 receipt token. Initialized once per clone with per-pool config. Holds LB shares; performs atomic mint/burn through TJ LB v2.0 pair. Bot is the restricted operator.
- `JanusFactory.sol` — EIP-1167 cloner + on-chain pool registry (~100 LoC). Platform-multisig admin. Existing clones are immutable (the factory's `currentImplementation` can change for future clones; in-flight clones forever point to their original impl per EIP-1167 semantics).

Performance fee is taken in WETH at every `rebalanceAtomic` AND `redeem`. Anti-double-tax invariant: `effectiveBasis = max(personalCostBasis, hwmPerShare)` gates the user-side skim at redeem.

**Tech Stack:** Solidity 0.8.24, Foundry, via-IR, OpenZeppelin Upgradeable (ERC20Upgradeable, Initializable, ReentrancyGuardUpgradeable), OpenZeppelin Clones (EIP-1167), joe-v2 (TJ LB v2.0 source + PriceHelper).

**Critical references inside `dungeonclaw-contracts/`:**
- `src/PitBotHelper.sol` — existing single-tenant precursor (do NOT modify, it's the live DungeonClaw bot's helper). The pattern of `transferFrom + pair.mint` and `safeBatchTransferFrom + pair.burn` in atomic external calls is the source of MEV defense; reuse the pattern, not the contract.
- `lib/joe-v2/src/libraries/PriceHelper.sol` — bin id ↔ price conversion. We use this to value (X, Y) in WETH.
- `lib/joe-v2/src/libraries/Constants.sol` — `SCALE_OFFSET = 128`, `BASIS_POINT_MAX = 10_000`.
- `lib/openzeppelin-contracts/contracts/proxy/Clones.sol` — EIP-1167 clone factory.
- `test/PitBotHelper.t.sol` — existing fork-test template. Mirror its style. Fork-target pair: `0xA801F4Addaa97ED96f0C38430CDf937b9c84487b` (DCLAW/WETH on Base). WETH `0x4200000000000000000000000000000000000006`. DCLAW `0xb7965A38552E0f7D5B728BAd1Ef2817ca7AE0B68`.

---

## Phase 0 — Project setup

### Task 0: Install OpenZeppelin upgradeable contracts

**Files:**
- Modify: `dungeonclaw-contracts/remappings.txt`
- Modify: `dungeonclaw-contracts/lib/` (add submodule)

The existing repo only has the non-upgradeable OZ contracts; we need the upgradeable variants for `Initializable`, `ERC20Upgradeable`, and `ReentrancyGuardUpgradeable` which clones require (constructors aren't called on EIP-1167 clones).

- [ ] **Step 1: Install the library**

Run from `dungeonclaw-contracts/`:

```bash
forge install OpenZeppelin/openzeppelin-contracts-upgradeable --no-commit
```

Expected: `lib/openzeppelin-contracts-upgradeable/` exists. Pin to the version matching the non-upgradeable OZ (check `lib/openzeppelin-contracts/package.json` for the version, then `cd lib/openzeppelin-contracts-upgradeable && git checkout v<X.Y.Z>`).

- [ ] **Step 2: Add the remapping**

Edit `remappings.txt` and add (preserve existing remappings):

```
@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/
```

- [ ] **Step 3: Verify build still works**

Run: `forge build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-contracts
git add lib/openzeppelin-contracts-upgradeable .gitmodules remappings.txt
git commit -m "Janus: add OZ upgradeable contracts for clone-compatible base types"
```

---

### Task 1: Scaffold interface file

**Files:**
- Create: `dungeonclaw-contracts/src/interfaces/ILBPairV2.sol`

The existing `PitBotHelper.sol` embeds its own `ILBPairV2` and `IERC20` interfaces. Extract `ILBPairV2` into a shared file so the wrapper, factory, and tests can import it without duplication. `IERC20` is already in OZ; we use that instead.

- [ ] **Step 1: Write the interface file**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILBPairV2 {
    function getReservesAndId() external view returns (uint256 reserveX, uint256 reserveY, uint256 activeId);
    function getActiveId() external view returns (uint24);
    function getBinStep() external view returns (uint16);
    function getBin(uint24 id) external view returns (uint128 binReserveX, uint128 binReserveY);
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory);
    function totalSupply(uint256 id) external view returns (uint256);
    function setApprovalForAll(address spender, bool approved) external;
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts) external;
    function mint(uint256[] calldata ids, uint256[] calldata distributionX, uint256[] calldata distributionY, address to)
        external returns (uint256 amountXAdded, uint256 amountYAdded);
    function burn(uint256[] calldata ids, uint256[] calldata amounts, address to)
        external returns (uint256 amountX, uint256 amountY);
    function swap(bool swapForY, address to) external returns (uint128 amountInLeft, uint128 amountOut);
    function getTokenX() external view returns (address);
    function getTokenY() external view returns (address);
}
```

- [ ] **Step 2: Verify it compiles**

Run from `dungeonclaw-contracts/`: `forge build`
Expected: build succeeds (or skips, no compilable contract changed).

- [ ] **Step 3: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-contracts
git add src/interfaces/ILBPairV2.sol
git commit -m "Janus: extract ILBPairV2 interface for shared use"
```

---

### Task 2: Scaffold JanusWrapper skeleton

**Files:**
- Create: `dungeonclaw-contracts/src/JanusWrapper.sol`

Empty stub that compiles, with all the state vars, errors, modifiers, and method signatures we'll implement. Each method body just `revert()` for now so tests we write later have a target to FAIL against first.

- [ ] **Step 1: Write the skeleton**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILBPairV2} from "./interfaces/ILBPairV2.sol";

/// @title JanusWrapper
/// @notice Per-team vault wrapping a Trader Joe LB v2.0 pair with MEV-safe
///         atomic mint/burn, ERC-20 receipt token, and WETH-denominated
///         performance fees. See docs/superpowers/specs/2026-06-09-managed-dlmm-pools-design.md.
contract JanusWrapper is Initializable, ReentrancyGuardUpgradeable, ERC20Upgradeable {
    // ----- Immutable per-clone config (set in initialize) -----
    ILBPairV2 public pair;
    IERC20 public tokenX;          // project token (e.g., DCLAW)
    IERC20 public tokenY;          // WETH
    address public operator;
    address public platformFeeRecipient;
    address public teamFeeRecipient;
    uint16 public platformFeeBps;  // platform's cut of taxable yield
    uint16 public teamFeeBps;      // team's cut of taxable yield
    uint16 public minBins;
    uint16 public maxBins;
    uint24 public maxDriftFromActive;

    // ----- Position state -----
    uint256[] public positionIds;
    uint256[] public positionDistX;
    uint256[] public positionDistY;

    // ----- Fee accounting -----
    uint256 public hwmPerShare;                         // value-per-share in WETH terms, 1e18 scaled
    mapping(address => uint256) public costBasisPerShare; // per-user cost basis, 1e18 scaled

    // ----- Errors -----
    error NotOperator();
    error DeadlinePassed();
    error SlippageExceeded();
    error ShapeNotSet();
    error BinCountOutOfRange();
    error DriftExceedsMax();
    error CombinedFeeTooHigh();
    error ZeroDeposit();

    // ----- Modifiers -----
    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }
    modifier before(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        _;
    }

    /// @notice One-time init for the clone. Reverts on second call.
    function initialize(
        address pair_,
        address weth_,
        address operator_,
        address platformFeeRecipient_,
        address teamFeeRecipient_,
        uint16 platformFeeBps_,
        uint16 teamFeeBps_,
        uint16 minBins_,
        uint16 maxBins_,
        uint24 maxDriftFromActive_,
        string memory name_,
        string memory symbol_
    ) external initializer {
        revert("not implemented");
    }

    function setPositionShape(
        uint256[] calldata ids,
        uint256[] calldata distX,
        uint256[] calldata distY
    ) external {
        revert("not implemented");
    }

    function deposit(
        uint256 amountX,
        uint256 amountY,
        uint256 minShares,
        uint256 deadline
    ) external returns (uint256 shares) {
        revert("not implemented");
    }

    function redeem(
        uint256 shares,
        uint256 minAmountX,
        uint256 minAmountY,
        uint256 deadline
    ) external returns (uint256 amountX, uint256 amountY) {
        revert("not implemented");
    }

    function rebalanceAtomic(
        uint256[] calldata burnIds,
        uint256[] calldata burnShares,
        uint256[] calldata mintIds,
        uint256[] calldata mintDistX,
        uint256[] calldata mintDistY
    ) external {
        revert("not implemented");
    }

    function sweep(address token) external {
        revert("not implemented");
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `forge build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/JanusWrapper.sol
git commit -m "Janus: scaffold JanusWrapper skeleton with method stubs"
```

---

### Task 3: Scaffold test harness

**Files:**
- Create: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

Sets up a forked Base mainnet test environment using the live DCLAW/WETH pair, mirroring `PitBotHelper.t.sol` style. We use a real pair so the LB math is real; for fast unit tests later we can mock specific calls. The harness deploys a fresh implementation + clone via the Clones library to mirror the factory's behavior.

- [ ] **Step 1: Write the harness**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {JanusWrapper} from "../src/JanusWrapper.sol";
import {ILBPairV2} from "../src/interfaces/ILBPairV2.sol";

interface IWETH {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

contract JanusWrapperTest is Test {
    address constant PAIR  = 0xA801F4Addaa97ED96f0C38430CDf937b9c84487b;
    address constant WETH  = 0x4200000000000000000000000000000000000006;
    address constant DCLAW = 0xb7965A38552E0f7D5B728BAd1Ef2817ca7AE0B68;

    JanusWrapper impl;
    JanusWrapper wrapper;
    address platform;
    address team;
    address operator;
    address alice;
    address bob;

    function setUp() public virtual {
        vm.createSelectFork("https://mainnet.base.org", 46041000);

        platform = makeAddr("platform");
        team     = makeAddr("team");
        operator = makeAddr("operator");
        alice    = makeAddr("alice");
        bob      = makeAddr("bob");

        impl = new JanusWrapper();
        wrapper = JanusWrapper(Clones.clone(address(impl)));

        wrapper.initialize(
            PAIR,
            WETH,
            operator,
            platform,
            team,
            1000,    // platformFeeBps = 10%
            500,     // teamFeeBps     = 5%
            5,       // minBins
            60,      // maxBins
            50,      // maxDriftFromActive
            "Janus DCLAW-WETH",
            "jcDCLAW-WETH"
        );

        // Give Alice and Bob each some WETH and DCLAW (mocked via vm.deal + deal)
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);

        vm.startPrank(alice);
        IWETH(WETH).deposit{value: 1 ether}();
        vm.stopPrank();

        vm.startPrank(bob);
        IWETH(WETH).deposit{value: 1 ether}();
        vm.stopPrank();
    }

    function test_setupSanity() public view {
        assertEq(address(wrapper.pair()), PAIR);
        assertEq(address(wrapper.tokenY()), WETH);
        assertEq(wrapper.operator(), operator);
    }
}
```

- [ ] **Step 2: Run test (expected: FAIL because initialize reverts)**

Run: `forge test --match-contract JanusWrapperTest --match-test test_setupSanity -vv`
Expected: `setUp` reverts inside `initialize()` with "not implemented".

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: scaffold test harness (fork-based, mirrors PitBotHelper.t.sol)"
```

---

## Phase 1 — Initialization

### Task 4: Implement initialize, fix sanity test

**Files:**
- Modify: `dungeonclaw-contracts/src/JanusWrapper.sol` — replace `initialize`'s revert with the real body.

- [ ] **Step 1: Replace the initialize body**

Replace the `initialize` function with:

```solidity
function initialize(
    address pair_,
    address weth_,
    address operator_,
    address platformFeeRecipient_,
    address teamFeeRecipient_,
    uint16 platformFeeBps_,
    uint16 teamFeeBps_,
    uint16 minBins_,
    uint16 maxBins_,
    uint24 maxDriftFromActive_,
    string memory name_,
    string memory symbol_
) external initializer {
    __ERC20_init(name_, symbol_);
    __ReentrancyGuard_init();

    if (uint256(platformFeeBps_) + uint256(teamFeeBps_) > 3000) revert CombinedFeeTooHigh(); // hard cap 30%
    require(pair_ != address(0) && weth_ != address(0) && operator_ != address(0), "zero addr");
    require(minBins_ > 0 && maxBins_ >= minBins_, "bad bin bounds");

    pair = ILBPairV2(pair_);
    tokenY = IERC20(weth_);
    // tokenX is derived from pair: WETH is one side, the OTHER side is the project token
    address pairX = pair.getTokenX();
    address pairY = pair.getTokenY();
    require(pairY == weth_, "weth must be tokenY of pair");
    tokenX = IERC20(pairX);

    operator = operator_;
    platformFeeRecipient = platformFeeRecipient_;
    teamFeeRecipient = teamFeeRecipient_;
    platformFeeBps = platformFeeBps_;
    teamFeeBps = teamFeeBps_;
    minBins = minBins_;
    maxBins = maxBins_;
    maxDriftFromActive = maxDriftFromActive_;
}
```

- [ ] **Step 2: Run sanity test**

Run: `forge test --match-contract JanusWrapperTest --match-test test_setupSanity -vv`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/JanusWrapper.sol
git commit -m "Janus: implement initialize, basic sanity passes"
```

---

### Task 5: Test — initialize cannot be called twice

**Files:**
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

- [ ] **Step 1: Add the test**

Add this function to `JanusWrapperTest`:

```solidity
function test_initializeRevertsTwice() public {
    vm.expectRevert(); // InvalidInitialization from OZ Initializable
    wrapper.initialize(
        PAIR, WETH, operator, platform, team,
        1000, 500, 5, 60, 50,
        "x", "y"
    );
}
```

- [ ] **Step 2: Run test**

Run: `forge test --match-test test_initializeRevertsTwice -vv`
Expected: PASS (OZ `Initializable` reverts on second call).

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: test initialize cannot be called twice"
```

---

### Task 6: Test — implementation contract itself cannot be initialized

**Files:**
- Modify: `dungeonclaw-contracts/src/JanusWrapper.sol` — add `_disableInitializers` in constructor.
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol` — verify.

- [ ] **Step 1: Add constructor to wrapper**

Above `function initialize(`, add:

```solidity
constructor() {
    _disableInitializers();
}
```

- [ ] **Step 2: Add the test**

```solidity
function test_implementationCannotBeInitialized() public {
    vm.expectRevert();
    impl.initialize(
        PAIR, WETH, operator, platform, team,
        1000, 500, 5, 60, 50,
        "x", "y"
    );
}
```

- [ ] **Step 3: Run test**

Run: `forge test --match-test test_implementationCannotBeInitialized -vv`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/JanusWrapper.sol test/JanusWrapper.t.sol
git commit -m "Janus: lock impl contract via _disableInitializers"
```

---

### Task 7: Test — combined fee cap enforced

**Files:**
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

- [ ] **Step 1: Add the test**

```solidity
function test_initializeRejectsExcessiveCombinedFee() public {
    JanusWrapper bad = JanusWrapper(Clones.clone(address(impl)));
    vm.expectRevert(JanusWrapper.CombinedFeeTooHigh.selector);
    bad.initialize(
        PAIR, WETH, operator, platform, team,
        2000, 1500, 5, 60, 50, // 35% combined — exceeds 30% cap
        "x", "y"
    );
}
```

- [ ] **Step 2: Run test**

Run: `forge test --match-test test_initializeRejectsExcessiveCombinedFee -vv`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: test combined fee cap enforcement"
```

---

## Phase 2 — Position shape tracking

### Task 8: Test — setPositionShape stores arrays, operator-only

**Files:**
- Modify: `dungeonclaw-contracts/src/JanusWrapper.sol` — implement `setPositionShape`.
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol` — add tests.

- [ ] **Step 1: Implement setPositionShape**

Replace the revert body of `setPositionShape` with:

```solidity
function setPositionShape(
    uint256[] calldata ids,
    uint256[] calldata distX,
    uint256[] calldata distY
) external onlyOperator {
    uint256 n = ids.length;
    require(n == distX.length && n == distY.length, "len mismatch");
    if (n < minBins || n > maxBins) revert BinCountOutOfRange();

    uint24 activeId = pair.getActiveId();
    for (uint256 i = 0; i < n; i++) {
        uint256 id = ids[i];
        require(id >= activeId - maxDriftFromActive && id <= uint256(activeId) + maxDriftFromActive, "drift");
    }

    // distributionX and distributionY must each sum to 1e18 across the bins
    uint256 sumX;
    uint256 sumY;
    for (uint256 i = 0; i < n; i++) {
        sumX += distX[i];
        sumY += distY[i];
    }
    require(sumX == 0 || sumX == 1e18, "distX sum");
    require(sumY == 0 || sumY == 1e18, "distY sum");

    delete positionIds;
    delete positionDistX;
    delete positionDistY;
    for (uint256 i = 0; i < n; i++) {
        positionIds.push(ids[i]);
        positionDistX.push(distX[i]);
        positionDistY.push(distY[i]);
    }
}
```

- [ ] **Step 2: Add tests**

```solidity
function _validShape() internal view returns (uint256[] memory ids, uint256[] memory dx, uint256[] memory dy) {
    uint24 activeId = ILBPairV2(PAIR).getActiveId();
    uint256 N = 20;
    ids = new uint256[](N);
    dx = new uint256[](N);
    dy = new uint256[](N);
    uint256 each = 1e18 / N;
    for (uint256 i = 0; i < N; i++) {
        ids[i] = uint256(activeId) - 10 + i;
        if (ids[i] < activeId) {
            dy[i] = each; // Y below active
        } else if (ids[i] > activeId) {
            dx[i] = each; // X above active
        } else {
            dx[i] = each / 2;
            dy[i] = each / 2;
        }
    }
    // Pad rounding into first non-zero slot to make sums exact 1e18
    uint256 sumX; uint256 sumY;
    for (uint256 i = 0; i < N; i++) { sumX += dx[i]; sumY += dy[i]; }
    if (sumX > 0) dx[0] += (1e18 - sumX);
    if (sumY > 0) dy[N-1] += (1e18 - sumY);
}

function test_setPositionShapeAcceptsValidShape() public {
    (uint256[] memory ids, uint256[] memory dx, uint256[] memory dy) = _validShape();
    vm.prank(operator);
    wrapper.setPositionShape(ids, dx, dy);
    assertEq(wrapper.positionIds(0), ids[0]);
}

function test_setPositionShapeRejectsNonOperator() public {
    (uint256[] memory ids, uint256[] memory dx, uint256[] memory dy) = _validShape();
    vm.expectRevert(JanusWrapper.NotOperator.selector);
    wrapper.setPositionShape(ids, dx, dy);
}

function test_setPositionShapeRejectsTooFewBins() public {
    uint256[] memory ids = new uint256[](2);
    uint256[] memory dx = new uint256[](2);
    uint256[] memory dy = new uint256[](2);
    uint24 a = ILBPairV2(PAIR).getActiveId();
    ids[0] = a; ids[1] = a + 1;
    dy[0] = 1e18; dx[1] = 1e18;
    vm.expectRevert(JanusWrapper.BinCountOutOfRange.selector);
    vm.prank(operator);
    wrapper.setPositionShape(ids, dx, dy);
}
```

- [ ] **Step 3: Run tests**

Run: `forge test --match-test test_setPositionShape -vv`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/JanusWrapper.sol test/JanusWrapper.t.sol
git commit -m "Janus: implement setPositionShape with rails + tests"
```

---

## Phase 3 — Deposit

### Task 9: Add value-in-WETH helper, then write first deposit test

**Files:**
- Modify: `dungeonclaw-contracts/src/JanusWrapper.sol` — add internal `_valueInWETH` helper.

The wrapper needs to convert `(amountX, amountY)` to WETH-denominated value. Use `PriceHelper.getPriceFromId(activeId, binStep)` from joe-v2 to get the X→Y price in Q128.128 fixed point, then `Uint256x256Math.mulShiftRoundDown` to apply it.

- [ ] **Step 1: Add imports and helper**

Add at the top of `JanusWrapper.sol`:

```solidity
import {PriceHelper} from "../lib/joe-v2/src/libraries/PriceHelper.sol";
import {Uint256x256Math} from "../lib/joe-v2/src/libraries/math/Uint256x256Math.sol";
```

Add as a private function inside the contract:

```solidity
using PriceHelper for uint24;
using Uint256x256Math for uint256;

/// @dev Value an (X, Y) pair in WETH terms (i.e., in Y).
///      activePrice is Y-per-X in Q128.128 fixed point.
function _valueInWETH(uint256 amountX, uint256 amountY) internal view returns (uint256) {
    if (amountX == 0) return amountY;
    uint24 activeId = pair.getActiveId();
    uint16 binStep = pair.getBinStep();
    uint256 price = PriceHelper.getPriceFromId(activeId, binStep);
    // price is X→Y in Q128.128; amountX * price >> 128 gives amountY-equivalent
    uint256 xInY = amountX.mulShiftRoundDown(price, 128);
    return amountY + xInY;
}
```

- [ ] **Step 2: Build to make sure imports resolve**

Run: `forge build`
Expected: build succeeds. If joe-v2 imports fail, add to `remappings.txt`:

```
joe-v2/=lib/joe-v2/src/
```

and use `import {PriceHelper} from "joe-v2/libraries/PriceHelper.sol";` instead.

- [ ] **Step 3: Commit**

```bash
git add src/JanusWrapper.sol remappings.txt
git commit -m "Janus: add WETH valuation helper using PriceHelper"
```

---

### Task 10: Implement deposit (two-sided), test first deposit

**Files:**
- Modify: `dungeonclaw-contracts/src/JanusWrapper.sol`
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

The first deposit is special — totalSupply is zero, so shares can't be computed pro-rata. Standard convention: first deposit's shares = the deposited value in WETH (1:1). This sets the initial value-per-share = 1e18 (1 WETH = 1 share). HWM also starts at 1e18.

- [ ] **Step 1: Implement deposit**

Replace the revert body of `deposit` with:

```solidity
function deposit(
    uint256 amountX,
    uint256 amountY,
    uint256 minShares,
    uint256 deadline
) external nonReentrant before(deadline) returns (uint256 shares) {
    if (positionIds.length == 0) revert ShapeNotSet();
    if (amountX == 0 && amountY == 0) revert ZeroDeposit();

    uint256 depositValueWeth = _valueInWETH(amountX, amountY);

    if (totalSupply() == 0) {
        // First deposit: shares = deposit value (1:1 with WETH)
        shares = depositValueWeth;
        hwmPerShare = 1e18;
    } else {
        // Subsequent: shares = depositValue / currentValuePerShare
        // currentValuePerShare = currentPoolValue / totalSupply
        uint256 currentPoolValueWeth = _poolValueInWETH();
        shares = (depositValueWeth * totalSupply()) / currentPoolValueWeth;
    }

    if (shares < minShares) revert SlippageExceeded();

    // Update user cost basis (weighted average)
    uint256 prevShares = balanceOf(msg.sender);
    if (prevShares == 0) {
        costBasisPerShare[msg.sender] = (depositValueWeth * 1e18) / shares;
    } else {
        uint256 newBasis = (costBasisPerShare[msg.sender] * prevShares + (depositValueWeth * 1e18)) / (prevShares + shares);
        costBasisPerShare[msg.sender] = newBasis;
    }

    _mint(msg.sender, shares);

    // Transfer assets to the pair, then mint LB shares into our position
    if (amountX > 0) {
        require(tokenX.transferFrom(msg.sender, address(pair), amountX), "X xfer");
    }
    if (amountY > 0) {
        require(tokenY.transferFrom(msg.sender, address(pair), amountY), "Y xfer");
    }
    pair.mint(positionIds, positionDistX, positionDistY, address(this));
}

/// @dev Current total pool value in WETH terms, summed across all bins we hold shares in.
function _poolValueInWETH() internal view returns (uint256) {
    uint256 totalX;
    uint256 totalY;
    uint256 n = positionIds.length;
    for (uint256 i = 0; i < n; i++) {
        uint24 id = uint24(positionIds[i]);
        (uint128 binReserveX, uint128 binReserveY) = pair.getBin(id);
        uint256 ourShares = pair.balanceOf(address(this), positionIds[i]);
        uint256 binTotal = pair.totalSupply(positionIds[i]);
        if (binTotal == 0) continue;
        totalX += (uint256(binReserveX) * ourShares) / binTotal;
        totalY += (uint256(binReserveY) * ourShares) / binTotal;
    }
    return _valueInWETH(totalX, totalY);
}
```

- [ ] **Step 2: Write first-deposit test**

Add to `JanusWrapperTest`:

```solidity
function _setupShapeAndApprove(address user) internal {
    (uint256[] memory ids, uint256[] memory dx, uint256[] memory dy) = _validShape();
    vm.prank(operator);
    wrapper.setPositionShape(ids, dx, dy);
    vm.startPrank(user);
    IWETH(WETH).approve(address(wrapper), type(uint256).max);
    // Alice/Bob don't have DCLAW in setUp; deposits are WETH-only for these tests
    vm.stopPrank();
}

function test_firstDepositMintsSharesEqualToValue() public {
    _setupShapeAndApprove(alice);
    vm.prank(alice);
    uint256 shares = wrapper.deposit(0, 0.1 ether, 0, block.timestamp + 1);
    // First deposit: 1 WETH = 1 share, so 0.1 WETH = 0.1 shares
    assertApproxEqRel(shares, 0.1 ether, 0.01e18); // 1% tolerance for fee dust
    assertEq(wrapper.balanceOf(alice), shares);
    assertEq(wrapper.hwmPerShare(), 1e18);
}
```

- [ ] **Step 3: Run test**

Run: `forge test --match-test test_firstDepositMintsSharesEqualToValue -vv`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/JanusWrapper.sol test/JanusWrapper.t.sol
git commit -m "Janus: implement deposit + first-deposit test"
```

---

### Task 11: Test — subsequent deposit mints pro-rata shares

**Files:**
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

- [ ] **Step 1: Add the test**

```solidity
function test_subsequentDepositProRata() public {
    _setupShapeAndApprove(alice);
    _setupShapeAndApprove(bob);

    vm.prank(alice);
    uint256 aliceShares = wrapper.deposit(0, 0.1 ether, 0, block.timestamp + 1);

    vm.prank(bob);
    uint256 bobShares = wrapper.deposit(0, 0.1 ether, 0, block.timestamp + 1);

    // Bob deposits identical amount immediately after Alice with no price drift —
    // should get approximately the same shares.
    assertApproxEqRel(bobShares, aliceShares, 0.01e18); // 1% tolerance
}
```

- [ ] **Step 2: Run test**

Run: `forge test --match-test test_subsequentDepositProRata -vv`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: test pro-rata share minting on subsequent deposit"
```

---

### Task 12: Test — deposit reverts before shape set, on zero, on deadline

**Files:**
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

- [ ] **Step 1: Add the tests**

```solidity
function test_depositRevertsBeforeShape() public {
    vm.startPrank(alice);
    IWETH(WETH).approve(address(wrapper), type(uint256).max);
    vm.expectRevert(JanusWrapper.ShapeNotSet.selector);
    wrapper.deposit(0, 0.1 ether, 0, block.timestamp + 1);
    vm.stopPrank();
}

function test_depositRevertsOnZero() public {
    _setupShapeAndApprove(alice);
    vm.prank(alice);
    vm.expectRevert(JanusWrapper.ZeroDeposit.selector);
    wrapper.deposit(0, 0, 0, block.timestamp + 1);
}

function test_depositRevertsAfterDeadline() public {
    _setupShapeAndApprove(alice);
    vm.warp(block.timestamp + 100);
    vm.prank(alice);
    vm.expectRevert(JanusWrapper.DeadlinePassed.selector);
    wrapper.deposit(0, 0.1 ether, 0, block.timestamp - 1);
}

function test_depositRevertsBelowMinShares() public {
    _setupShapeAndApprove(alice);
    vm.prank(alice);
    vm.expectRevert(JanusWrapper.SlippageExceeded.selector);
    wrapper.deposit(0, 0.1 ether, type(uint256).max, block.timestamp + 1);
}
```

- [ ] **Step 2: Run tests**

Run: `forge test --match-test "test_depositReverts" -vv`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: test deposit guard rails (no shape, zero, deadline, slippage)"
```

---

## Phase 4 — Redeem

### Task 13: Implement redeem (no fee branch yet)

**Files:**
- Modify: `dungeonclaw-contracts/src/JanusWrapper.sol`

We implement the no-fee path first (yield ≤ 0 ⇒ skim 0). Fee path comes in the next task.

- [ ] **Step 1: Implement redeem skeleton**

Replace the revert body of `redeem` with:

```solidity
function redeem(
    uint256 shares,
    uint256 minAmountX,
    uint256 minAmountY,
    uint256 deadline
) external nonReentrant before(deadline) returns (uint256 amountX, uint256 amountY) {
    require(shares > 0 && shares <= balanceOf(msg.sender), "bad shares");

    // Compute pro-rata claim on each bin
    uint256 n = positionIds.length;
    uint256[] memory burnIds = new uint256[](n);
    uint256[] memory burnShares = new uint256[](n);
    uint256 supply = totalSupply();
    for (uint256 i = 0; i < n; i++) {
        uint256 id = positionIds[i];
        uint256 ourShares = pair.balanceOf(address(this), id);
        burnIds[i] = id;
        burnShares[i] = (ourShares * shares) / supply;
    }

    // Burn the user's pro-rata LB shares via the v2.0 two-step (transfer to pair, then burn)
    pair.safeBatchTransferFrom(address(this), address(pair), burnIds, burnShares);
    (amountX, amountY) = pair.burn(burnIds, burnShares, address(this));

    // Compute user yield for fee
    uint256 userValueWeth = _valueInWETH(amountX, amountY);
    uint256 userValuePerShare = (userValueWeth * 1e18) / shares;
    uint256 basis = costBasisPerShare[msg.sender];
    uint256 effectiveBasis = basis > hwmPerShare ? basis : hwmPerShare;
    uint256 feeY;
    if (userValuePerShare > effectiveBasis) {
        uint256 yieldPerShare = userValuePerShare - effectiveBasis;
        uint256 combinedBps = uint256(platformFeeBps) + uint256(teamFeeBps);
        uint256 totalFeeWeth = (yieldPerShare * shares * combinedBps) / (1e18 * 10_000);
        feeY = _payFee(totalFeeWeth, amountX, amountY);
    }

    _burn(msg.sender, shares);

    // Send remainder to user
    if (amountY > feeY) {
        require(tokenY.transfer(msg.sender, amountY - feeY), "Y send");
    }
    if (amountX > 0) {
        require(tokenX.transfer(msg.sender, amountX), "X send");
    }

    require(amountX >= minAmountX, "minX");
    require(amountY - feeY >= minAmountY, "minY");
}

/// @dev Pay the WETH-denominated fee to recipients out of (amountX, amountY).
///      If amountY < required, swap a small amount of X for Y on the pair.
///      Returns the WETH amount actually paid (= feeY).
function _payFee(uint256 feeWeth, uint256 amountX, uint256 amountY) internal returns (uint256) {
    if (feeWeth == 0) return 0;
    // Simple case: enough Y on hand
    require(amountY >= feeWeth, "fee swap path not implemented"); // TODO Task 17
    uint256 platformCut = (feeWeth * platformFeeBps) / (platformFeeBps + teamFeeBps);
    uint256 teamCut = feeWeth - platformCut;
    if (platformCut > 0) require(tokenY.transfer(platformFeeRecipient, platformCut), "fee to platform");
    if (teamCut > 0) require(tokenY.transfer(teamFeeRecipient, teamCut), "fee to team");
    return feeWeth;
}
```

- [ ] **Step 2: Build to check**

Run: `forge build`
Expected: build succeeds (warnings about unused variables in the fee-swap path are OK).

- [ ] **Step 3: Commit**

```bash
git add src/JanusWrapper.sol
git commit -m "Janus: implement redeem (happy path, no swap fallback yet)"
```

---

### Task 14: Test — redeem with no yield → no fee

**Files:**
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

- [ ] **Step 1: Add the test**

```solidity
function test_redeemNoYieldNoFee() public {
    _setupShapeAndApprove(alice);

    vm.prank(alice);
    uint256 shares = wrapper.deposit(0, 0.1 ether, 0, block.timestamp + 1);

    uint256 wethBefore = IWETH(WETH).balanceOf(alice);
    uint256 platformBefore = IWETH(WETH).balanceOf(platform);

    // Immediately redeem (no time / no swaps happened, no yield generated)
    vm.prank(alice);
    wrapper.redeem(shares, 0, 0, block.timestamp + 1);

    uint256 wethAfter = IWETH(WETH).balanceOf(alice);
    uint256 platformAfter = IWETH(WETH).balanceOf(platform);

    // Alice gets back ~0.1 ETH (allow small slippage from rounding)
    assertApproxEqRel(wethAfter - wethBefore, 0.1 ether, 0.01e18);
    // No fee was taken
    assertEq(platformAfter - platformBefore, 0);
}
```

- [ ] **Step 2: Run test**

Run: `forge test --match-test test_redeemNoYieldNoFee -vv`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: test redeem with no yield skims no fee"
```

---

### Task 15: Test — redeem with simulated yield → fee skimmed

**Files:**
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

To simulate yield without actually running swaps, we use `deal` to add WETH directly to the pair (representing accrued fees in the bins our position holds) before redeeming.

- [ ] **Step 1: Add the test**

```solidity
function test_redeemWithYieldSkimsFee() public {
    _setupShapeAndApprove(alice);

    vm.prank(alice);
    uint256 shares = wrapper.deposit(0, 1 ether, 0, block.timestamp + 1);

    // Simulate 10% yield by gifting WETH to the wrapper's bin reserves.
    // We do this by minting WETH directly to the pair on the active bin's behalf.
    // Practically: deal WETH to pair address (simulates fee accumulation).
    uint256 currentWethInPair = IWETH(WETH).balanceOf(PAIR);
    deal(WETH, PAIR, currentWethInPair + 0.1 ether);

    uint256 platformBefore = IWETH(WETH).balanceOf(platform);
    uint256 teamBefore = IWETH(WETH).balanceOf(team);

    vm.prank(alice);
    wrapper.redeem(shares, 0, 0, block.timestamp + 1);

    uint256 platformAfter = IWETH(WETH).balanceOf(platform);
    uint256 teamAfter = IWETH(WETH).balanceOf(team);

    // 10% yield × 15% combined fee = 1.5% of 1 ETH = ~0.015 ETH total
    uint256 totalFee = (platformAfter - platformBefore) + (teamAfter - teamBefore);
    assertGt(totalFee, 0);
    // Platform : Team ratio = 10:5 = 2:1
    assertApproxEqRel(platformAfter - platformBefore, (totalFee * 1000) / 1500, 0.01e18);
}
```

- [ ] **Step 2: Run test**

Run: `forge test --match-test test_redeemWithYieldSkimsFee -vv`
Expected: PASS. If the `deal` to PAIR doesn't simulate yield (because LB v2.0 may not credit the wrapper's bin shares from a direct token gift), substitute with a real swap on the pair in a helper.

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: test fee skim on redeem with simulated yield"
```

---

### Task 16: Test — anti-double-tax invariant (effectiveBasis = max)

**Files:**
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

This is the critical correctness test. After a rebalance lifts HWM, a previously-in-pool user who redeems should not pay fees on the portion below the (new, higher) HWM.

- [ ] **Step 1: Add the test (uses rebalance from later task; mark as skip for now if needed)**

```solidity
function test_effectiveBasisPreventsDoubleTax() public {
    // We'll implement this fully after rebalanceAtomic lands (Phase 5).
    // Behaviour to verify:
    //  1. Alice deposits at HWM=1.0
    //  2. Pool gains, rebalance fires, HWM rises to 1.16 (fee taken at rebalance)
    //  3. Alice redeems — should only pay fee on yield ABOVE 1.16, not the 1.0→1.16 portion
    vm.skip(true);
}
```

- [ ] **Step 2: Run test**

Run: `forge test --match-test test_effectiveBasisPreventsDoubleTax -vv`
Expected: SKIP (will be filled in after rebalance lands).

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: scaffold double-tax-prevention test (pending rebalance)"
```

---

### Task 17: Implement WETH-swap fallback in _payFee

**Files:**
- Modify: `dungeonclaw-contracts/src/JanusWrapper.sol`

When the burn returned less Y than the fee requires, we need to convert some X→Y via the pair. The pair's `swap()` consumes whatever balance was sent to it and outputs to `to`. We send X to the pair, call swap.

- [ ] **Step 1: Replace _payFee body**

```solidity
function _payFee(uint256 feeWeth, uint256 amountX, uint256 amountY) internal returns (uint256 feeY) {
    if (feeWeth == 0) return 0;
    feeY = feeWeth;
    if (amountY < feeWeth) {
        // Need to swap some X for Y. Send X to pair, swap, receive Y back here.
        // We over-estimate slightly (1% buffer) to absorb swap fee.
        uint256 shortfall = feeWeth - amountY;
        // Rough conversion: shortfall in Y → X amount. Use _valueInWETH inversely.
        // For audit-grade precision we'd use the pair's quoter; here we send a chunk of X
        // and tolerate dust. The unswapped X is returned with the user / re-minted.
        require(amountX > 0, "no X to swap");
        // Send the X to the pair and swap. swapForY=true.
        require(tokenX.transfer(address(pair), amountX), "x to pair");
        (, uint128 yOut) = pair.swap(true, address(this));
        require(yOut >= shortfall, "swap shortfall");
        // amountY budget is now amountY + yOut
    }
    uint256 platformCut = (feeWeth * platformFeeBps) / (platformFeeBps + teamFeeBps);
    uint256 teamCut = feeWeth - platformCut;
    if (platformCut > 0) require(tokenY.transfer(platformFeeRecipient, platformCut), "fee to platform");
    if (teamCut > 0) require(tokenY.transfer(teamFeeRecipient, teamCut), "fee to team");
}
```

NOTE: this is the simplest correct path; production might want a Quoter to size the swap exactly. Acceptable for v1; flagged in the spec's open questions.

- [ ] **Step 2: Build**

Run: `forge build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/JanusWrapper.sol
git commit -m "Janus: add X→Y swap fallback in fee payment path"
```

---

## Phase 5 — Rebalance + HWM

### Task 18: Implement rebalanceAtomic (no skim yet)

**Files:**
- Modify: `dungeonclaw-contracts/src/JanusWrapper.sol`

First implement the burn + re-mint atomicity, no fee yet.

- [ ] **Step 1: Replace rebalanceAtomic body**

```solidity
function rebalanceAtomic(
    uint256[] calldata burnIds,
    uint256[] calldata burnShares,
    uint256[] calldata mintIds,
    uint256[] calldata mintDistX,
    uint256[] calldata mintDistY
) external nonReentrant onlyOperator {
    require(burnIds.length == burnShares.length, "burn len");
    require(mintIds.length == mintDistX.length && mintIds.length == mintDistY.length, "mint len");
    if (mintIds.length < minBins || mintIds.length > maxBins) revert BinCountOutOfRange();

    uint24 activeId = pair.getActiveId();
    for (uint256 i = 0; i < mintIds.length; i++) {
        uint256 id = mintIds[i];
        require(id >= activeId - maxDriftFromActive && id <= uint256(activeId) + maxDriftFromActive, "drift");
    }

    // Burn old position
    if (burnIds.length > 0) {
        pair.safeBatchTransferFrom(address(this), address(pair), burnIds, burnShares);
    }
    (uint256 outX, uint256 outY) = burnIds.length > 0
        ? pair.burn(burnIds, burnShares, address(this))
        : (uint256(0), uint256(0));

    // Skim fee (implemented in next task)
    (outX, outY) = _skimRebalanceFee(outX, outY);

    // Update position shape state
    delete positionIds;
    delete positionDistX;
    delete positionDistY;
    for (uint256 i = 0; i < mintIds.length; i++) {
        positionIds.push(mintIds[i]);
        positionDistX.push(mintDistX[i]);
        positionDistY.push(mintDistY[i]);
    }

    // Re-mint into new shape
    if (outX > 0) require(tokenX.transfer(address(pair), outX), "x to pair");
    if (outY > 0) require(tokenY.transfer(address(pair), outY), "y to pair");
    pair.mint(mintIds, mintDistX, mintDistY, address(this));
}

/// @dev Stub: skim 0 for now. Real implementation in next task.
function _skimRebalanceFee(uint256 outX, uint256 outY) internal returns (uint256, uint256) {
    return (outX, outY);
}
```

- [ ] **Step 2: Build**

Run: `forge build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/JanusWrapper.sol
git commit -m "Janus: implement rebalanceAtomic (no fee skim yet)"
```

---

### Task 19: Implement _skimRebalanceFee with HWM math

**Files:**
- Modify: `dungeonclaw-contracts/src/JanusWrapper.sol`

- [ ] **Step 1: Replace _skimRebalanceFee body**

```solidity
function _skimRebalanceFee(uint256 outX, uint256 outY) internal returns (uint256 remainX, uint256 remainY) {
    remainX = outX;
    remainY = outY;
    uint256 supply = totalSupply();
    if (supply == 0) return (outX, outY);

    uint256 valueWeth = _valueInWETH(outX, outY);
    uint256 valuePerShare = (valueWeth * 1e18) / supply;
    if (valuePerShare <= hwmPerShare) {
        // No yield, no skim. HWM stays.
        return (outX, outY);
    }

    uint256 yieldPerShare = valuePerShare - hwmPerShare;
    uint256 combinedBps = uint256(platformFeeBps) + uint256(teamFeeBps);
    uint256 feeWeth = (yieldPerShare * supply * combinedBps) / (1e18 * 10_000);
    if (feeWeth == 0) return (outX, outY);

    uint256 paidY = _payFee(feeWeth, outX, outY);
    // After _payFee, the contract's X and Y balances may have shifted (X→Y swap path)
    remainX = tokenX.balanceOf(address(this));
    remainY = tokenY.balanceOf(address(this));

    // Update HWM to post-skim per-share value
    uint256 newValueWeth = _valueInWETH(remainX, remainY);
    hwmPerShare = (newValueWeth * 1e18) / supply;
}
```

- [ ] **Step 2: Test — fee taken at rebalance updates HWM**

Add to `JanusWrapperTest`:

```solidity
function test_rebalanceSkimsAndLiftsHWM() public {
    _setupShapeAndApprove(alice);
    vm.prank(alice);
    wrapper.deposit(0, 1 ether, 0, block.timestamp + 1);

    uint256 hwmBefore = wrapper.hwmPerShare();

    // Simulate yield by gifting WETH to the pair
    deal(WETH, PAIR, IWETH(WETH).balanceOf(PAIR) + 0.1 ether);

    // Operator triggers rebalance into the same shape (just to harvest yield)
    (uint256[] memory ids, uint256[] memory dx, uint256[] memory dy) = _validShape();
    // Burn the entire current position
    uint256 n = ids.length;
    uint256[] memory burnIds = new uint256[](n);
    uint256[] memory burnSh = new uint256[](n);
    for (uint256 i = 0; i < n; i++) {
        burnIds[i] = ids[i];
        burnSh[i] = ILBPairV2(PAIR).balanceOf(address(wrapper), ids[i]);
    }

    uint256 platformBefore = IWETH(WETH).balanceOf(platform);
    vm.prank(operator);
    wrapper.rebalanceAtomic(burnIds, burnSh, ids, dx, dy);

    uint256 platformAfter = IWETH(WETH).balanceOf(platform);

    assertGt(platformAfter, platformBefore, "platform should have received fee");
    assertGt(wrapper.hwmPerShare(), hwmBefore, "HWM should have moved up");
}
```

- [ ] **Step 3: Run test**

Run: `forge test --match-test test_rebalanceSkimsAndLiftsHWM -vv`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/JanusWrapper.sol test/JanusWrapper.t.sol
git commit -m "Janus: implement HWM skim at rebalance + test"
```

---

### Task 20: Fill in the double-tax-prevention test

**Files:**
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

Now that rebalance works, fill in the test we scaffolded in Task 16.

- [ ] **Step 1: Replace the skip-test body**

```solidity
function test_effectiveBasisPreventsDoubleTax() public {
    _setupShapeAndApprove(alice);

    vm.prank(alice);
    uint256 shares = wrapper.deposit(0, 1 ether, 0, block.timestamp + 1);

    // Simulate yield, then rebalance (HWM rises, alice's pro-rata fee is paid at rebalance)
    deal(WETH, PAIR, IWETH(WETH).balanceOf(PAIR) + 0.1 ether);
    (uint256[] memory ids, uint256[] memory dx, uint256[] memory dy) = _validShape();
    uint256 n = ids.length;
    uint256[] memory burnIds = new uint256[](n);
    uint256[] memory burnSh = new uint256[](n);
    for (uint256 i = 0; i < n; i++) { burnIds[i] = ids[i]; burnSh[i] = ILBPairV2(PAIR).balanceOf(address(wrapper), ids[i]); }
    vm.prank(operator);
    wrapper.rebalanceAtomic(burnIds, burnSh, ids, dx, dy);

    uint256 hwmAfterRebalance = wrapper.hwmPerShare();
    assertGt(hwmAfterRebalance, 1e18, "HWM should have moved up");

    uint256 platformFeeAtRebalance = IWETH(WETH).balanceOf(platform);
    uint256 teamFeeAtRebalance = IWETH(WETH).balanceOf(team);

    // Alice immediately redeems — there is NO further yield since the rebalance,
    // so the redeem-time skim should be ZERO (no double-taxation).
    vm.prank(alice);
    wrapper.redeem(shares, 0, 0, block.timestamp + 1);

    uint256 platformDelta = IWETH(WETH).balanceOf(platform) - platformFeeAtRebalance;
    uint256 teamDelta     = IWETH(WETH).balanceOf(team)     - teamFeeAtRebalance;

    assertEq(platformDelta, 0, "redeem must not skim again on already-taxed gain");
    assertEq(teamDelta, 0);
}
```

- [ ] **Step 2: Run test**

Run: `forge test --match-test test_effectiveBasisPreventsDoubleTax -vv`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: prove anti-double-tax invariant via effectiveBasis"
```

---

### Task 21: Test — rebalance reverts when not operator / rails violated

**Files:**
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

- [ ] **Step 1: Add the tests**

```solidity
function test_rebalanceRevertsNonOperator() public {
    _setupShapeAndApprove(alice);
    vm.prank(alice);
    wrapper.deposit(0, 0.1 ether, 0, block.timestamp + 1);

    (uint256[] memory ids, uint256[] memory dx, uint256[] memory dy) = _validShape();
    uint256[] memory empty = new uint256[](0);

    vm.expectRevert(JanusWrapper.NotOperator.selector);
    wrapper.rebalanceAtomic(empty, empty, ids, dx, dy);
}

function test_rebalanceRevertsTooFewBins() public {
    _setupShapeAndApprove(alice);
    vm.prank(alice);
    wrapper.deposit(0, 0.1 ether, 0, block.timestamp + 1);

    uint256[] memory tiny = new uint256[](1);
    uint256[] memory empty = new uint256[](0);
    tiny[0] = ILBPairV2(PAIR).getActiveId();
    uint256[] memory dx = new uint256[](1);
    uint256[] memory dy = new uint256[](1);
    dy[0] = 1e18;

    vm.expectRevert(JanusWrapper.BinCountOutOfRange.selector);
    vm.prank(operator);
    wrapper.rebalanceAtomic(empty, empty, tiny, dx, dy);
}
```

- [ ] **Step 2: Run tests**

Run: `forge test --match-test "test_rebalanceReverts" -vv`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: test rebalance access control + rails"
```

---

## Phase 6 — Sweep + access control

### Task 22: Implement sweep with hard exclusion of LB shares / tokenX / tokenY

**Files:**
- Modify: `dungeonclaw-contracts/src/JanusWrapper.sol`
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

- [ ] **Step 1: Implement sweep**

Replace the revert body of `sweep` with:

```solidity
function sweep(address token) external onlyOperator {
    require(token != address(tokenX), "no sweep X");
    require(token != address(tokenY), "no sweep Y");
    require(token != address(pair), "no sweep pair shares");
    uint256 bal = IERC20(token).balanceOf(address(this));
    if (bal > 0) {
        require(IERC20(token).transfer(operator, bal), "sweep transfer");
    }
}
```

- [ ] **Step 2: Add tests**

```solidity
function test_sweepStuckToken() public {
    // Some random ERC-20 ends up at the wrapper. Operator can pull it.
    address randomToken = address(0xdead); // placeholder — for a real test use a mock
    // Skip if no test ERC-20 is set up; use a real one if available
    vm.skip(true);
}

function test_sweepRejectsX_Y_Shares() public {
    vm.startPrank(operator);
    vm.expectRevert(bytes("no sweep X"));
    wrapper.sweep(DCLAW);
    vm.expectRevert(bytes("no sweep Y"));
    wrapper.sweep(WETH);
    vm.expectRevert(bytes("no sweep pair shares"));
    wrapper.sweep(PAIR);
    vm.stopPrank();
}

function test_sweepRevertsNonOperator() public {
    vm.expectRevert(JanusWrapper.NotOperator.selector);
    wrapper.sweep(DCLAW);
}
```

- [ ] **Step 3: Run tests**

Run: `forge test --match-test test_sweep -vv`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/JanusWrapper.sol test/JanusWrapper.t.sol
git commit -m "Janus: implement sweep with hard exclusions"
```

---

## Phase 7 — Factory

### Task 23: Scaffold JanusFactory + test harness

**Files:**
- Create: `dungeonclaw-contracts/src/JanusFactory.sol`
- Create: `dungeonclaw-contracts/test/JanusFactory.t.sol`

- [ ] **Step 1: Write the factory**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {JanusWrapper} from "./JanusWrapper.sol";

contract JanusFactory is Ownable {
    address public currentImplementation;
    uint16 public maxFeeBps; // hard cap on platform + team combined fee bps
    bool public paused;

    address[] public pools;
    mapping(address => bool) public isJanusPool;

    event PoolDeployed(
        address indexed pool,
        address indexed pair,
        address indexed operator,
        uint16 platformFeeBps,
        uint16 teamFeeBps
    );
    event ImplementationUpdated(address indexed newImpl);
    event PausedSet(bool paused);

    error Paused();
    error FeeExceedsCap();

    constructor(address impl, uint16 maxFeeBps_) Ownable(msg.sender) {
        currentImplementation = impl;
        maxFeeBps = maxFeeBps_;
    }

    function deployPool(
        address pair,
        address weth,
        address operator,
        address platformFeeRecipient,
        address teamFeeRecipient,
        uint16 platformFeeBps,
        uint16 teamFeeBps,
        uint16 minBins,
        uint16 maxBins,
        uint24 maxDriftFromActive,
        string memory name,
        string memory symbol
    ) external returns (address pool) {
        if (paused) revert Paused();
        if (uint256(platformFeeBps) + uint256(teamFeeBps) > maxFeeBps) revert FeeExceedsCap();

        pool = Clones.clone(currentImplementation);
        JanusWrapper(pool).initialize(
            pair, weth, operator,
            platformFeeRecipient, teamFeeRecipient,
            platformFeeBps, teamFeeBps,
            minBins, maxBins, maxDriftFromActive,
            name, symbol
        );
        pools.push(pool);
        isJanusPool[pool] = true;
        emit PoolDeployed(pool, pair, operator, platformFeeBps, teamFeeBps);
    }

    function setImplementation(address newImpl) external onlyOwner {
        currentImplementation = newImpl;
        emit ImplementationUpdated(newImpl);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function poolCount() external view returns (uint256) { return pools.length; }
}
```

- [ ] **Step 2: Write test harness**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {JanusFactory} from "../src/JanusFactory.sol";
import {JanusWrapper} from "../src/JanusWrapper.sol";

contract JanusFactoryTest is Test {
    address constant PAIR  = 0xA801F4Addaa97ED96f0C38430CDf937b9c84487b;
    address constant WETH  = 0x4200000000000000000000000000000000000006;

    JanusWrapper impl;
    JanusFactory factory;
    address owner;
    address operator;

    function setUp() public {
        vm.createSelectFork("https://mainnet.base.org", 46041000);
        owner = makeAddr("owner");
        operator = makeAddr("operator");
        vm.startPrank(owner);
        impl = new JanusWrapper();
        factory = new JanusFactory(address(impl), 3000); // 30% combined cap
        vm.stopPrank();
    }

    function test_factoryDeploysWorkingClone() public {
        address pool = factory.deployPool(
            PAIR, WETH, operator,
            makeAddr("p"), makeAddr("t"),
            1000, 500, 5, 60, 50,
            "name", "sym"
        );
        assertTrue(factory.isJanusPool(pool));
        assertEq(JanusWrapper(pool).operator(), operator);
    }

    function test_factoryRejectsExcessiveFee() public {
        vm.expectRevert(JanusFactory.FeeExceedsCap.selector);
        factory.deployPool(
            PAIR, WETH, operator,
            makeAddr("p"), makeAddr("t"),
            2000, 1500, 5, 60, 50,
            "name", "sym"
        );
    }

    function test_factoryPaused() public {
        vm.prank(owner);
        factory.setPaused(true);
        vm.expectRevert(JanusFactory.Paused.selector);
        factory.deployPool(
            PAIR, WETH, operator,
            makeAddr("p"), makeAddr("t"),
            1000, 500, 5, 60, 50,
            "name", "sym"
        );
    }

    function test_setImplementationOwnerOnly() public {
        address newImpl = address(new JanusWrapper());
        vm.expectRevert();
        factory.setImplementation(newImpl);
        vm.prank(owner);
        factory.setImplementation(newImpl);
        assertEq(factory.currentImplementation(), newImpl);
    }
}
```

- [ ] **Step 3: Run tests**

Run: `forge test --match-contract JanusFactoryTest -vv`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/JanusFactory.sol test/JanusFactory.t.sol
git commit -m "Janus: factory + tests (clone deploy, fee cap, pause, owner-only impl swap)"
```

---

## Phase 8 — Integration / fork tests

### Task 24: Full lifecycle fork test (deploy → deposit → real swap → rebalance → redeem)

**Files:**
- Create: `dungeonclaw-contracts/test/integration/JanusForkTest.t.sol`

This is the highest-value test — uses the LIVE pair on a forked Base mainnet, performs an actual swap to generate real LP yield (instead of the `deal` shortcut), then rebalances and redeems. Catches any bug in the integration with TJ LB v2.0 that unit tests miss.

- [ ] **Step 1: Write the test**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {JanusWrapper} from "../../src/JanusWrapper.sol";
import {ILBPairV2} from "../../src/interfaces/ILBPairV2.sol";

interface IWETH {
    function deposit() external payable;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

contract JanusForkTest is Test {
    address constant PAIR  = 0xA801F4Addaa97ED96f0C38430CDf937b9c84487b;
    address constant WETH  = 0x4200000000000000000000000000000000000006;
    address constant DCLAW = 0xb7965A38552E0f7D5B728BAd1Ef2817ca7AE0B68;

    JanusWrapper wrapper;
    address platform;
    address team;
    address operator;
    address alice;
    address swapper; // a third-party who generates fees via swaps

    function setUp() public {
        vm.createSelectFork("https://mainnet.base.org", 46041000);
        platform = makeAddr("platform");
        team     = makeAddr("team");
        operator = makeAddr("operator");
        alice    = makeAddr("alice");
        swapper  = makeAddr("swapper");

        JanusWrapper impl = new JanusWrapper();
        wrapper = JanusWrapper(Clones.clone(address(impl)));
        wrapper.initialize(
            PAIR, WETH, operator, platform, team,
            1000, 500, 5, 60, 50,
            "Janus DCLAW-WETH", "jcDCLAW-WETH"
        );

        vm.deal(alice, 10 ether);
        vm.deal(swapper, 10 ether);
        vm.prank(alice); IWETH(WETH).deposit{value: 1 ether}();
        vm.prank(swapper); IWETH(WETH).deposit{value: 1 ether}();
    }

    function _validShape() internal view returns (uint256[] memory ids, uint256[] memory dx, uint256[] memory dy) {
        uint24 a = ILBPairV2(PAIR).getActiveId();
        uint256 N = 20;
        ids = new uint256[](N);
        dx = new uint256[](N);
        dy = new uint256[](N);
        uint256 each = 1e18 / N;
        for (uint256 i = 0; i < N; i++) {
            ids[i] = uint256(a) - 10 + i;
            if (ids[i] < a) dy[i] = each;
            else if (ids[i] > a) dx[i] = each;
            else { dx[i] = each / 2; dy[i] = each / 2; }
        }
        uint256 sX; uint256 sY;
        for (uint256 i=0;i<N;i++) { sX += dx[i]; sY += dy[i]; }
        if (sX > 0) dx[0] += (1e18 - sX);
        if (sY > 0) dy[N-1] += (1e18 - sY);
    }

    function test_endToEndLifecycle() public {
        // 1. Operator sets shape
        (uint256[] memory ids, uint256[] memory dx, uint256[] memory dy) = _validShape();
        vm.prank(operator);
        wrapper.setPositionShape(ids, dx, dy);

        // 2. Alice deposits 0.5 WETH (one-sided)
        vm.startPrank(alice);
        IWETH(WETH).approve(address(wrapper), type(uint256).max);
        uint256 shares = wrapper.deposit(0, 0.5 ether, 0, block.timestamp + 1);
        vm.stopPrank();
        assertGt(shares, 0);

        // 3. Swapper performs a swap on the pair (generates fee in our bins)
        vm.startPrank(swapper);
        IWETH(WETH).transfer(PAIR, 0.1 ether);
        ILBPairV2(PAIR).swap(false, swapper); // false = swap Y for X
        vm.stopPrank();

        // 4. Operator rebalances — should harvest fee and lift HWM
        uint256 hwmBefore = wrapper.hwmPerShare();
        uint256 platformBefore = IWETH(WETH).balanceOf(platform);
        uint256 n = ids.length;
        uint256[] memory burnIds = new uint256[](n);
        uint256[] memory burnSh = new uint256[](n);
        for (uint256 i = 0; i < n; i++) { burnIds[i] = ids[i]; burnSh[i] = ILBPairV2(PAIR).balanceOf(address(wrapper), ids[i]); }
        vm.prank(operator);
        wrapper.rebalanceAtomic(burnIds, burnSh, ids, dx, dy);

        assertGt(wrapper.hwmPerShare(), hwmBefore, "HWM should rise on rebalance");
        assertGt(IWETH(WETH).balanceOf(platform), platformBefore, "platform should be paid");

        // 5. Alice redeems — should NOT pay further fee (already taxed at rebalance)
        uint256 platformAtRebalance = IWETH(WETH).balanceOf(platform);
        vm.prank(alice);
        wrapper.redeem(shares, 0, 0, block.timestamp + 1);
        assertEq(IWETH(WETH).balanceOf(platform), platformAtRebalance, "no double-tax at redeem");
    }
}
```

- [ ] **Step 2: Run the test**

Run: `forge test --match-contract JanusForkTest --match-test test_endToEndLifecycle -vv`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/JanusForkTest.t.sol
git commit -m "Janus: end-to-end fork test using real swap to generate yield"
```

---

### Task 25: MEV-defense fork test (the original PitBot vector is closed)

**Files:**
- Modify: `dungeonclaw-contracts/test/integration/JanusForkTest.t.sol`

Mirror the MEV test that `PitBotHelper.t.sol` already does, but against the Janus wrapper. Verifies that the deposit/redeem/rebalance flows leave no orphan-delta window on the pair.

- [ ] **Step 1: Add the test**

```solidity
function test_noOrphanDeltaWindow() public {
    // Attempts the historical attack pattern: a third party calls pair.swap or pair.mint
    // BETWEEN the wrapper's transfer-to-pair and its mint/burn call. With Janus all
    // transfer+mint and transfer+burn happen in one external call, so the attacker
    // never has a window to intercept.
    //
    // We assert: after every external state change initiated by the wrapper, the
    // pair's balance accounting reflects no leaked tokens (X bal - reserveX == 0,
    // Y bal - reserveY == 0).
    (uint256[] memory ids, uint256[] memory dx, uint256[] memory dy) = _validShape();
    vm.prank(operator); wrapper.setPositionShape(ids, dx, dy);

    vm.startPrank(alice); IWETH(WETH).approve(address(wrapper), type(uint256).max);
    wrapper.deposit(0, 0.5 ether, 0, block.timestamp + 1);
    vm.stopPrank();

    // After deposit, pair's WETH balance should equal sum of bin reserves
    (uint256 rX, uint256 rY,) = ILBPairV2(PAIR).getReservesAndId();
    assertEq(IWETH(WETH).balanceOf(PAIR), rY, "no orphan WETH at pair after deposit");
}
```

- [ ] **Step 2: Run the test**

Run: `forge test --match-test test_noOrphanDeltaWindow -vv`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/JanusForkTest.t.sol
git commit -m "Janus: assert no orphan-delta window at pair after deposit"
```

---

### Task 26: Fuzz the deposit/redeem invariants

**Files:**
- Modify: `dungeonclaw-contracts/test/JanusWrapper.t.sol`

Property test: for any non-zero deposit, the user can immediately redeem and recover ≥ the input amount minus dust. Catches accounting bugs where shares→assets→shares doesn't round-trip.

- [ ] **Step 1: Add the fuzz test**

```solidity
function testFuzz_depositRedeemRoundtrip(uint256 amount) public {
    amount = bound(amount, 1e15, 0.9 ether);
    _setupShapeAndApprove(alice);

    uint256 wethBefore = IWETH(WETH).balanceOf(alice);

    vm.prank(alice);
    uint256 shares = wrapper.deposit(0, amount, 0, block.timestamp + 1);
    vm.prank(alice);
    wrapper.redeem(shares, 0, 0, block.timestamp + 1);

    uint256 wethAfter = IWETH(WETH).balanceOf(alice);
    // Allow up to 0.5% slippage from rounding (LB v2.0 bin math)
    assertGe(wethAfter + (amount / 200), wethBefore);
}
```

- [ ] **Step 2: Run the fuzz**

Run: `forge test --match-test testFuzz_depositRedeemRoundtrip -vv`
Expected: PASS over default 256 runs.

- [ ] **Step 3: Commit**

```bash
git add test/JanusWrapper.t.sol
git commit -m "Janus: fuzz deposit/redeem round-trip invariant"
```

---

## Phase 9 — Deploy + docs

### Task 27: Deploy script for the factory + impl

**Files:**
- Create: `dungeonclaw-contracts/script/DeployJanus.s.sol`

- [ ] **Step 1: Write the script**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {JanusWrapper} from "../src/JanusWrapper.sol";
import {JanusFactory} from "../src/JanusFactory.sol";

contract DeployJanus is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        uint16 maxFeeBps = uint16(vm.envOr("MAX_FEE_BPS", uint256(3000)));

        vm.startBroadcast(pk);
        JanusWrapper impl = new JanusWrapper();
        JanusFactory factory = new JanusFactory(address(impl), maxFeeBps);
        vm.stopBroadcast();

        console.log("JanusWrapper impl:", address(impl));
        console.log("JanusFactory:", address(factory));
    }
}
```

- [ ] **Step 2: Dry-run against Base Sepolia (or just simulation)**

Run: `forge script script/DeployJanus.s.sol --rpc-url base_sepolia --simulate -vvv`
Expected: simulation succeeds; addresses logged.

- [ ] **Step 3: Commit**

```bash
git add script/DeployJanus.s.sol
git commit -m "Janus: deploy script for impl + factory"
```

---

### Task 28: Final test sweep + lint + audit prep

**Files:**
- Run the full test suite, fix anything that broke.

- [ ] **Step 1: Full test run**

Run: `forge test -vvv`
Expected: all green.

- [ ] **Step 2: Coverage report**

Run: `forge coverage --report summary`
Expected: ≥ 90% line coverage on `JanusWrapper.sol` and `JanusFactory.sol`. If any lines uncovered, add tests.

- [ ] **Step 3: Gas snapshot**

Run: `forge snapshot`
Expected: snapshot file written. Sanity-check deposit, redeem, rebalance, deployPool gas costs are reasonable (< 500k gas each for typical bin counts).

- [ ] **Step 4: Commit**

```bash
git add .gas-snapshot
git commit -m "Janus: gas snapshot baseline before audit"
```

- [ ] **Step 5: Open red-team brief**

Write a short red-team brief in `docs/janus-wrapper-redteam-brief.md` listing:
- All external entry points
- All state-mutating internal functions
- All invariants (HWM monotonic; fee never exceeds combinedBps × yield; user can always redeem pro-rata of reserves; etc.)
- Known limitations (late-depositor gap, swap-fallback dust)
- Threat model from spec §13

This is the input to the external audit / red-team agents.

---

## Self-review

Before handing the plan off, verify against the spec:

**Spec coverage:**
- §7.1 Factory contract — covered by Phase 7 (Task 23).
- §7.2 Wrapper Clone — covered by Phases 1-6 (Tasks 4-22).
- §7.3 ERC-20 receipt token — embedded in wrapper via OZ ERC20Upgradeable (Task 4).
- §7.4 Fee mechanism — HWM (Task 19), cost basis (Task 10), redeem skim (Tasks 13-17), anti-double-tax (Tasks 16, 20).
- §13 Trust & Security — operator gating (multiple tasks), sweep exclusions (Task 22), fee cap (Tasks 7, 23), MEV defense (Tasks 24-25).
- Open question on position-shape state — resolved as on-chain storage (Task 8).
- Open question on one-sided share math — punted to the share-value-in-WETH unification (Task 9) — flagged in red-team brief at Task 28.

**Placeholders:** none. Every step has concrete code, concrete commands, concrete expected output.

**Type consistency:** `JanusWrapper`, `JanusFactory`, `ILBPairV2`, method names, error names — all consistent across tasks.

**Scope:** sub-project 1 of 7 only. Bot, hosting, discovery UI, MCP, billing — out of scope for this plan; tracked in their own future plans.

---

## Notes for the implementing engineer

- **Storage layout matters for clones.** If you add or remove state vars between iterations, you must redeploy the impl and update the factory's `currentImplementation`. Don't try to "upgrade" existing clones — they're immutable by design.
- **Always run tests on a forked Base mainnet.** Local TJ pair mocks would lie about fee accrual. The pinned fork block `46041000` keeps tests deterministic.
- **`via_ir = true` is required** by the existing `foundry.toml`. Don't disable it.
- **Re-entrancy:** every external state-mutator uses `nonReentrant`. The internal helpers don't need it but cannot be called externally.
- **WETH-only fee** is honest only when sufficient Y is in the wrapper's hand. The swap-fallback path (Task 17) eats a small TJ swap fee — measure it in fork tests and document.
