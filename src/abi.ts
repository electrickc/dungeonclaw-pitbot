// Trader Joe Liquidity Book v2.0 (LBPair) — minimal ABI for the bot's needs.
// Verified to match the deployed implementation at
// 0x37d11ffc23f4b87ae65a7ffd4951b331bded1dd9 via live calls in pool probing.
export const LB_PAIR_ABI = [
  'function getReservesAndId() view returns (uint256 reserveX, uint256 reserveY, uint256 activeId)',
  'function getBin(uint24 id) view returns (uint128 reserveX, uint128 reserveY)',
  'function feeParameters() view returns (bytes32)',
  'function tokenX() view returns (address)',
  'function tokenY() view returns (address)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
  'function totalSupply(uint256 id) view returns (uint256)',
  // Low-level: caller must transfer tokenX/tokenY to the pair BEFORE calling mint.
  // distributionX/Y are in 1e18-scaled fractions per bin (must sum to 1e18 each).
  'function mint(uint256[] ids, uint256[] distributionX, uint256[] distributionY, address to) returns (uint256 amountXAdded, uint256 amountYAdded)',
  'function burn(uint256[] ids, uint256[] amounts, address to) returns (uint256[] amountsX, uint256[] amountsY)',
  // Trader Joe v2.0 LBToken has a CUSTOM 4-arg signature (no `data` field),
  // not the standard ERC-1155 5-arg one. Critically, this implementation
  // does NOT invoke onERC1155Received on the recipient — which lets us
  // transfer LB shares TO the pair contract itself (the pair has no
  // ERC-1155 receiver hook). This is required because LBPair.burn burns
  // from address(this), so the shares must be transferred to the pair
  // before burning.
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts)',
  // Events
  'event Swap(address indexed sender, address indexed recipient, uint24 activeId, bytes32 amountsIn, bytes32 amountsOut, uint24 volatilityAccumulated, uint24 fees)',
  'event CompositionFee(address indexed sender, address indexed recipient, uint24 activeId, bytes32 totalFees)',
  'event LiquidityAdded(address indexed sender, address indexed recipient, uint256 indexed id, uint256 minted, uint256 amountX, uint256 amountY, uint256 distributionX, uint256 distributionY)',
  'event LiquidityRemoved(address indexed sender, address indexed recipient, uint256 indexed id, uint256 burned, uint256 amountX, uint256 amountY)',
] as const

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
] as const
