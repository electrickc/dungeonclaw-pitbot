# dungeonclaw-pitbot

DLMM bid-wall accumulator for DCLAW/WETH on SectorOne (Base mainnet).
Deployed to a SecretVM TEE; private key never leaves the enclave.

## What it does

Parks WETH in a skewed bid wall a few bins below the SectorOne DCLAW/WETH active
bin. When whales sell, the wall fills with DCLAW at a 7-22% discount to spot.
On a sell-fill, the bot withdraws both sides and rebuilds the wall lower. On a
sudden upward move ("big green candle"), it tracks up so the wall stays close
enough to catch the inevitable jeet.

Single-sided: starts with only WETH. DCLAW arrives as yield.

## Pool / chain details

| | |
|---|---|
| Chain | Base mainnet (8453) |
| Pool | `0xa801f4addaa97ed96f0c38430cdf937b9c84487b` |
| Token X | DCLAW `0xb7965A38552E0f7D5B728BAd1Ef2817ca7AE0B68` |
| Token Y | WETH `0x4200000000000000000000000000000000000006` |
| LB Factory | `0x217da3e53F221D1f36e8b09bc7d55d4012C0aa70` |
| LB Pair impl | `0x37d11ffc23f4b87ae65a7ffd4951b331bded1dd9` (TJ v2.0) |
| Bin step | 240 bps (2.4% per bin) |

The bot talks to the LB pair directly (transfer-then-mint pattern). It does
NOT use SectorOne's zap router — that router uses undocumented vanity
selectors and adds an unverified trust hop.

## Strategy v0

- 0.1 WETH total budget
- 7 bins, **exponential skew** `[1, 2, 4, 8, 16, 32, 64]` of 127 units total
- Wall starts 3 bins below active, extends 6 bins further down
  - Shallowest bin = `active - 3` (price -7% from spot)
  - Deepest bin = `active - 9` (price -22% from spot)
  - Deepest bin gets ~50% of capital
- Rebalance triggers:
  - Active bin drifts > 2 bins above wall center → withdraw + place higher
  - Any wall bin is below active (got filled) → withdraw + reset
- 60s cooldown between rebalances, 15s polling

## Secrets

All secrets are loaded from `/run/secrets/*` files inside the container
(SecretVM injects them at deploy time). The bot never reads secrets from
plain env vars unless `*_FILE` is also unset, in which case it falls back
for local dev only.

| Secret | Purpose |
|---|---|
| `BOT_PRIVATE_KEY` | Bot wallet signing key. Never leaves the TEE. |
| `DRPC_BASE_KEY` | dRPC URL path segment. Billable, treat as secret. |
| `ADMIN_WEBHOOK_HMAC` | Shared HMAC secret with dungeonclaw-admin. |

## External APIs

| Service | Direction | Auth |
|---|---|---|
| dRPC Base RPC | outbound | URL path segment (the secret above) |
| dungeonclaw-admin `/api/pitbot/event` | outbound | HMAC-SHA256 over body |

No inbound network. No DB. No bind-mounted state. On crash, wall state is
reconstructed from chain reads on next boot.

## Deployment to SecretVM

1. Fork / clone this repo to the TEE host.
2. Populate the three files referenced in `docker-compose.yml`:
   ```
   secrets/bot_private_key
   secrets/drpc_base_key
   secrets/admin_webhook_hmac
   ```
   (Or use SecretVM's injection mechanism — see your platform docs.)
3. Tune non-secret env vars in `docker-compose.yml` if defaults need adjusting.
4. **Keep `DRY_RUN=1` for first 24h.** The admin dashboard will show the bot's
   intended actions without sending any tx. After 24h of sane telemetry,
   flip `DRY_RUN=0` and restart.
5. `docker compose up -d`

## Kill switch

- Soft: set `KILL=1` in `docker-compose.yml`, `docker compose up -d`. Bot
  detects the flag at the top of each tick and exits cleanly.
- Hard: `docker compose down`. Wall stays on-chain; relaunching restores
  state from chain reads.

## Monitoring

All meaningful state changes emit a webhook event to
`https://admin.dungeonclaw.com/api/pitbot/event`. The admin UI at
`/admin/finance/pitbot` shows recent events and daily P&L.

Event types: `boot`, `tick`, `rebalance_placed`, `rebalance_skipped`,
`bin_filled`, `withdrawal`, `error`.

## Local dev

```bash
cp .env.example .env
# fill in the three secrets (use a throwaway key with no funds)
npm install
npm run dev
```

Default config has `DRY_RUN=1` so nothing hits chain.
