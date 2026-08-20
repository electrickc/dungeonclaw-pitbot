# Token Recovery Feature — Implementation Report

**Commit:** `2294186`
**Build:** `tsc` — clean, zero errors
**Tests:** 77/77 passed (vitest run)

---

## Diff Summary

### `src/abi.ts`
Added `decimals()` and `symbol()` view functions to `ERC20_ABI` so the recovery function can log human-readable token info.

### `src/controlPlane.ts`
- `SyncResponse`: added optional fields `recoverToSafe?: boolean`, `tokenXAddress?: string | null`, `tokenYAddress?: string | null`. Omitting them (older control-plane responses) is a no-op.
- `Event['type']`: added `'tokens_recovered'` to the union.

### `src/index.ts`
- Added `import { ERC20_ABI } from './abi'`.
- Added `recoverTokensToSafe(safeAddress, tokenAddrs)` after `returnGasToSafe`:
  - Uses `ensureBotWallet().connect(provider)` — same enclave signer, same RPC provider as `returnGasToSafe`. No new key construction.
  - Deduplicates token addresses; skips falsy/zero-balance tokens (idempotent).
  - Per-token try/catch: one failing token does not abort the others.
  - ERC-20 transfers FIRST, then `returnGasToSafe()` for native sweep LAST.
- Added dispatch block in `poll()` between the `retired` block and the `killSwitch` check:
  - Fires on `sync.recoverToSafe && sync.safeAddress`.
  - Passes `[tokenXAddress, tokenYAddress].filter(Boolean)` to `recoverTokensToSafe`.
  - Emits `tokens_recovered` event with swept details.
  - Returns after the sweep so no further tick logic runs (paused state is respected; the control plane clears the flag on seeing the event).

---

## Wallet / Enclave Key Reuse

`recoverTokensToSafe` calls `ensureBotWallet()` — the same function used by `returnGasToSafe` and `reconcile`. This reads the persisted `wallet.key` from the SecretVM's encrypted volume (or creates it once on first boot). The enclave signing key is **not reconstructed** from any other source; the same TEE-sealed identity is reused throughout.

---

## Follow-up: I-1 — per-token error reporting

**Commit:** `<pending>` (`fix(recover): report per-token errors so flag clears only on success`)
**Build:** `tsc` — clean.
**Tests:** 77/77 passed (no test asserted the recover return shape; none needed adjustment).

**Problem:** `tokens_recovered` fired even when all transfers failed. The old return (`swept[]`) was ambiguous: `swept:[]` meant BOTH "nothing to do / already recovered" (success) AND "every transfer threw" (failure). The control plane would clear `recoverToSafe` in both cases, losing the retry signal.

**Fix:**
- `recoverTokensToSafe` now returns `{ swept: {token,symbol,amount}[], errors: {token,error}[] }`.
- Each token `catch` pushes `{ token, error }` to `errors` (in addition to the existing log).
- The native `returnGasToSafe` sweep is now wrapped in try/catch; a failure pushes `{ token: 'native', error }` rather than aborting the function.
- `poll()` destructures `{ swept, errors }` and includes both in the emitted event payload. The event is still emitted unconditionally; the app clears the flag ONLY when `errors` is empty.

**Resulting semantics:** idempotent success (all balances already 0) → `swept:[] errors:[]` → app clears the flag. Any failure → `errors` non-empty → app keeps the flag → retried next poll.

Fund-routing, ERC-20-first/native-last ordering, and the gas-reserve math were NOT touched. Deferred findings I-2/I-3/I-4 were left untouched per instruction.
