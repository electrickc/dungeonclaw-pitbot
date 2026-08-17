// LB Pair v2.0 (matches deployed TJ pair on Base)
export const LB_PAIR_ABI = [
  'function mint(uint256[] ids, uint256[] distributionX, uint256[] distributionY, address to) returns (uint256 amountXAdded, uint256 amountYAdded)',
  'function burn(uint256[] ids, uint256[] amounts, address to) returns (uint256 amountX, uint256 amountY)',
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  // Batched share read — collapses a per-bin balanceOf loop into ONE call.
  // Without this, scanning a ~50-bin spot-wide window was 50-100 sequential
  // eth_calls and timed out on slower RPCs ("RPC timeout on binPositions").
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
  'function totalSupply(uint256 id) view returns (uint256)',
  'function getReservesAndId() view returns (uint256, uint256, uint256)',
  // Per-bin reserves — used by safeBinPositions() in v0.1.6+ for fill detection.
  // Missing this in v0.1.6 caused the bot to crash with
  // "this.pair.getBin is not a function" on every reconcile.
  'function getBin(uint24 id) view returns (uint256 reserveX, uint256 reserveY)',
  'function tokenX() view returns (address)',
  'function tokenY() view returns (address)',
  'function feeParameters() view returns (uint16, uint16, uint16, uint16, uint16, uint24, uint16, uint24, uint24, uint24, uint24, uint40)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
] as const

// JanusHelper — stateless, deployed once for the whole protocol
export const HELPER_ABI = [
  'function mintAtomic(address pair, address tokenX, address tokenY, uint256[] ids, uint256[] distributionX, uint256[] distributionY, uint256 amountX, uint256 amountY) returns (uint256 amountXAdded, uint256 amountYAdded)',
  'function burnAtomic(address pair, uint256[] ids, uint256[] shares) returns (uint256 amountX, uint256 amountY)',
  'function sweep(address token, address to)',
] as const

// Gnosis Safe v1.3+ (subset)
export const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function isOwner(address) view returns (bool)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
] as const

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
] as const

// Multicall3 — canonical CREATE2 address, deployed on Base AND Robinhood.
// Used to batch per-bin getBin() reads into a single eth_call.
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'
export const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
] as const
