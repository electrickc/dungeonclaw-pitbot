// LB Pair v2.0 (matches deployed TJ pair on Base)
export const LB_PAIR_ABI = [
  'function mint(uint256[] ids, uint256[] distributionX, uint256[] distributionY, address to) returns (uint256 amountXAdded, uint256 amountYAdded)',
  'function burn(uint256[] ids, uint256[] amounts, address to) returns (uint256 amountX, uint256 amountY)',
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function totalSupply(uint256 id) view returns (uint256)',
  'function getReservesAndId() view returns (uint256, uint256, uint256)',
  'function tokenX() view returns (address)',
  'function tokenY() view returns (address)',
  'function feeParameters() view returns (uint16, uint16, uint16, uint16, uint16, uint24, uint16, uint24, uint24, uint24, uint24, uint40)',
] as const

// JanusHelper (atomic mint+burn wrapper)
export const HELPER_ABI = [
  'function mintAtomic(uint256[] ids, uint256[] distributionX, uint256[] distributionY, uint256 amountX, uint256 amountY) returns (uint256 amountXAdded, uint256 amountYAdded)',
  'function burnAtomic(uint256[] ids, uint256[] shares) returns (uint256 amountX, uint256 amountY)',
  'function sweep(address token)',
  'function OWNER() view returns (address)',
  'function PAIR() view returns (address)',
  'function WETH() view returns (address)',
  'function DCLAW() view returns (address)',
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
