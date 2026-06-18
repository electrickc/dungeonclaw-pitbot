# Strategy Weight Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bias term to bid-ask and curve strategy weight functions so the smallest per-bin allocation stays above LB v2's minimum-shares threshold, eliminating the on-chain GS013 reverts.

**Architecture:** Two-line code change per strategy file (one constant + one `+ BIAS` term). Update existing tests with a new ≥ 2% invariant. Ship as v0.1.14 (build, push, janus-app YAML bump, vm-edit all 3 VMs).

**Tech Stack:** TypeScript, vitest 4.x, Docker.

**Spec:** `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/docs/superpowers/specs/2026-06-15-strategy-weight-floor-design.md`

---

## File Map

| File | Modified | Responsibility |
|---|---|---|
| `src/strategy/bid-ask.ts` | yes | Add `INNERMOST_BIAS=10n` constant + apply to weight |
| `src/strategy/curve.ts` | yes | Add `OUTERMOST_BIAS=3n` constant + apply to weight |
| `test/strategy/bid-ask.test.ts` | yes | Add ≥ 2%-of-ONE invariant test |
| `test/strategy/curve.test.ts` | yes | Add ≥ 2%-of-ONE invariant test |
| `package.json` | yes | Version bump 0.1.13 → 0.1.14 |
| `janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts` | yes | Image tag v0.1.13 → v0.1.14 |

---

## Task 1: Branch setup

**Files:** none.

The v0.1.13 work lives on the `feat/advanced-strategies` branch (which already has the reconcile-stuck recovery merged into it). Branch the fix from there, NOT from main, otherwise we'd lose v0.1.13's strategies and reconcile fixes.

- [ ] **Step 1: Verify v0.1.13 work is on `feat/advanced-strategies`**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git log feat/advanced-strategies --oneline -5
```

Expected: top commits include the v0.1.13 merge (`merge: reconcile-stuck recovery into advanced strategies (v0.1.13)`) and the bid-ask / curve / spot-concentrated / factory commits. If they're not there, escalate — we'd be branching from the wrong place.

- [ ] **Step 2: Create the new branch from feat/advanced-strategies**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git checkout feat/advanced-strategies
git checkout -b feat/strategy-weight-floor
```

Expected: switched to `feat/strategy-weight-floor`. `git status` shows clean working tree.

---

## Task 2: bid-ask weight bias + invariant test

**Files:**
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/src/strategy/bid-ask.ts`
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/test/strategy/bid-ask.test.ts`

- [ ] **Step 1: Write the failing invariant test**

Open `test/strategy/bid-ask.test.ts`. Inside the existing `describe('BidAskStrategy.plan', ...)` block, add this test after the existing "no phantom bins" test (and before the "rejects mismatched" test):

```ts
  it('every nonzero distribution value is at least 2% of ONE (LB v2 min-shares safety)', () => {
    const strat = new BidAskStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: ONE, yAvailable: ONE,
      binStep: 100,
    })
    const MIN = ONE / 50n  // 2%
    plan.distributionX.filter((d) => d > 0n).forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(MIN)
    })
    plan.distributionY.filter((d) => d > 0n).forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(MIN)
    })
  })
```

- [ ] **Step 2: Confirm the new test fails (existing bid-ask still uses unbiased weight)**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/strategy/bid-ask.test.ts
```

Expected: the new "every nonzero distribution value..." test fails because the unbiased weights give the innermost bin only 1/385 = 0.26% (well below 2%). All other tests still pass.

- [ ] **Step 3: Add the `INNERMOST_BIAS` constant and apply to the weight function**

In `src/strategy/bid-ask.ts`, near the top (alongside `const ONE = 10n ** 18n`), add:

```ts
// Floor that lifts the innermost-bin allocation above LB v2's effective
// min-shares-per-bin threshold (~1%). Without it, the natural (i+1)^2 weight
// drops the innermost bin to 0.26%, and LB v2's mint reverts (surfaces as
// Gnosis Safe GS013 from execTransaction).
const INNERMOST_BIAS = 10n
```

Then change `uShapeWeight` from:

```ts
function uShapeWeight(distanceFromActive: number): bigint {
  const d = BigInt(distanceFromActive + 1)
  return d * d
}
```

to:

```ts
function uShapeWeight(distanceFromActive: number): bigint {
  const d = BigInt(distanceFromActive + 1)
  return d * d + INNERMOST_BIAS
}
```

- [ ] **Step 4: Confirm all bid-ask tests pass (including the new invariant)**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/strategy/bid-ask.test.ts
```

Expected: all 7 tests pass (6 original + 1 new invariant).

- [ ] **Step 5: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add src/strategy/bid-ask.ts test/strategy/bid-ask.test.ts
git commit -m "strategy: bid-ask weight floor to clear LB v2 min-shares (fix GS013)"
```

---

## Task 3: curve weight bias + invariant test

**Files:**
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/src/strategy/curve.ts`
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/test/strategy/curve.test.ts`

- [ ] **Step 1: Write the failing invariant test**

Open `test/strategy/curve.test.ts`. Inside the existing `describe('CurveStrategy.plan', ...)` block, add this test after the existing "no phantom bins" test (and before "rejects mismatched"):

```ts
  it('every nonzero distribution value is at least 2% of ONE (LB v2 min-shares safety)', () => {
    const strat = new CurveStrategy({ binCount: 20, binsAbove: 10, binsBelow: 10 })
    const plan = strat.plan({
      activeBin: ACTIVE,
      xAvailable: ONE, yAvailable: ONE,
      binStep: 100,
    })
    const MIN = ONE / 50n  // 2%
    plan.distributionX.filter((d) => d > 0n).forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(MIN)
    })
    plan.distributionY.filter((d) => d > 0n).forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(MIN)
    })
  })
```

- [ ] **Step 2: Confirm the new test fails**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/strategy/curve.test.ts
```

Expected: the new invariant test fails — the unbiased curve gives the outermost bin 1/55 = 1.82%, below 2%. All other tests still pass.

- [ ] **Step 3: Add `OUTERMOST_BIAS` constant and apply to the weight function**

In `src/strategy/curve.ts`, near the top (alongside `const ONE = 10n ** 18n`), add:

```ts
// Floor that lifts the outermost-bin allocation above LB v2's effective
// min-shares-per-bin threshold (~1%). Without it, the linear taper drops
// the outermost bin to 1.82%, sitting on LB v2's revert boundary.
const OUTERMOST_BIAS = 3n
```

Then change `bellWeight` from:

```ts
function bellWeight(distanceFromActive: number, binsSide: number): bigint {
  const w = binsSide - distanceFromActive
  return w >= 1 ? BigInt(w) : 1n
}
```

to:

```ts
function bellWeight(distanceFromActive: number, binsSide: number): bigint {
  const w = binsSide - distanceFromActive
  return (w >= 1 ? BigInt(w) : 1n) + OUTERMOST_BIAS
}
```

- [ ] **Step 4: Confirm all curve tests pass**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npx vitest run test/strategy/curve.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Run full test suite to confirm nothing else regressed**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot && npm test 2>&1 | tail -5
```

Expected: all previous tests still pass + 2 new invariant tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add src/strategy/curve.ts test/strategy/curve.test.ts
git commit -m "strategy: curve weight floor to clear LB v2 min-shares (fix GS013)"
```

---

## Task 4: Version bump + docker build/push v0.1.14

**Files:**
- Modify: `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/package.json`

- [ ] **Step 1: Bump package.json**

In `/Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot/package.json`, change:

```json
"version": "0.1.13",
```

to:

```json
"version": "0.1.14",
```

- [ ] **Step 2: Commit version bump**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
git add package.json
git commit -m "v0.1.14: package version bump for strategy weight floor"
```

- [ ] **Step 3: Build image (linux/amd64 for SecretVM)**

```bash
cd /Users/electrickc/DUNGEONCLAW/dungeonclaw-pitbot
docker build --platform linux/amd64 -t ghcr.io/electrickc/janus-starter-bot:v0.1.14 . 2>&1 | tail -5
```

Expected: `naming to ghcr.io/electrickc/janus-starter-bot:v0.1.14 done`.

- [ ] **Step 4: Push**

```bash
docker push ghcr.io/electrickc/janus-starter-bot:v0.1.14 2>&1 | tail -3
```

Expected: `v0.1.14: digest: sha256:... size: ...` line.

- [ ] **Step 5: Verify image is pullable from registry**

```bash
docker manifest inspect ghcr.io/electrickc/janus-starter-bot:v0.1.14 | head -5
```

Expected: manifest JSON object, not "no such manifest".

---

## Task 5: Janus-app provision YAML + deploy

**Files:**
- Modify: `/Users/electrickc/DUNGEONLABS/janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts`

- [ ] **Step 1: Bump the image tag in the inlined YAML**

In `/Users/electrickc/DUNGEONLABS/janus-app/src/app/api/v1/admin/pools/[id]/provision/route.ts`, find:

```
image: ghcr.io/electrickc/janus-starter-bot:v0.1.13
```

Change to:

```
image: ghcr.io/electrickc/janus-starter-bot:v0.1.14
```

- [ ] **Step 2: Commit on janus-app main**

```bash
cd /Users/electrickc/DUNGEONLABS/janus-app
git add src/app/api/v1/admin/pools/[id]/provision/route.ts
git commit -m "provision: bump janus-starter-bot to v0.1.14

v0.1.14 adds weight floors to bid-ask and curve strategies so they
clear LB v2's min-shares threshold (was failing as Gnosis Safe GS013
on the first on-chain mint attempt)."
```

- [ ] **Step 3: Deploy**

```bash
cd /Users/electrickc/DUNGEONLABS/janus-app && npm run deploy:prod 2>&1 | tail -5
```

Expected: deploy succeeds, custom domain alias re-points.

---

## Task 6: Apply v0.1.14 to all 3 live VMs

**Files:** none (`secretvm-cli` operations + a temp compose file).

- [ ] **Step 1: Write the v0.1.14 compose YAML**

Write to `/tmp/janus-bot-compose-v0.1.14.yml`:

```yaml
services:
  bot:
    image: ghcr.io/electrickc/janus-starter-bot:v0.1.14
    environment:
      POOL_ID: ${POOL_ID}
      CONTROL_PLANE_URL: ${CONTROL_PLANE_URL}
      CONTROL_PLANE_TOKEN: ${CONTROL_PLANE_TOKEN}
      RPC_URL: ${RPC_URL}
      STATE_PATH: /data/state.json
    volumes:
      - bot-state:/data
    restart: unless-stopped

volumes:
  bot-state:
```

- [ ] **Step 2: Push to maroon-mandrill (Pool 1)**

```bash
secretvm-cli vm edit -d /tmp/janus-bot-compose-v0.1.14.yml cmqaod1dg00gmn0iqhcm2esrg 2>&1 | tail -3
```

Expected: `{"status":"success",...,"vm_name":"maroon-mandrill"}`.

- [ ] **Step 3: Push to salmon-guppy (Pool 2)**

```bash
secretvm-cli vm edit -d /tmp/janus-bot-compose-v0.1.14.yml cmq9zxfny00f4n0iq8c323d4n 2>&1 | tail -3
```

Expected: `{"status":"success",...,"vm_name":"salmon-guppy"}`.

- [ ] **Step 4: Push to emerald-barracuda (Pool 3)**

```bash
secretvm-cli vm edit -d /tmp/janus-bot-compose-v0.1.14.yml cmqeyve41007e31iq25303h88 2>&1 | tail -3
```

Expected: `{"status":"success",...,"vm_name":"emerald-barracuda"}`.

- [ ] **Step 5: Confirm new image is live on emerald-barracuda (the one that hit GS013)**

```bash
secretvm-cli vm status cmqeyve41007e31iq25303h88 2>&1 | grep -o 'janus-starter-bot:v0\.1\.[0-9]*' | head -1
```

Expected: `janus-starter-bot:v0.1.14`.

- [ ] **Step 6: Watch the emerald-barracuda bot logs for a successful mint**

After waiting ~60–90s for the VM to boot and reconcile, pull recent logs:

```bash
secretvm-cli vm logs cmqeyve41007e31iq25303h88 2>&1 | python3 -c "
import json, sys, re
d = json.load(sys.stdin)
lines = d['result'].split('\n')
keep = [l for l in lines if 'docker_wd-bot' in l and ('[reconcile]' in l or '[tick]' in l or '[op]' in l)]
for l in keep[-25:]:
    print(re.sub(r'^.+docker_wd-bot-1\[\d+\]:\s*', '', l).strip())
"
```

Expected sequence:
- `[reconcile] strategy=bid-ask signer/tx layers ready`
- `[reconcile] done in <N>ms`
- `[reconcile] → OPERATIONAL`
- `[tick] active=<bin> action=place reason=no position present`
- `[op] success` (NOT `[op] failure: ... GS013`)

If you still see `GS013`, the bias values weren't enough; bump `INNERMOST_BIAS` to 20n and re-ship.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Implementing task |
|---|---|
| bid-ask: `weight(d) = (d+1)² + 10` | Task 2 step 3 |
| curve: `weight(d) = (binsSide−d) + 3` | Task 3 step 3 |
| `INNERMOST_BIAS = 10n` constant | Task 2 step 3 |
| `OUTERMOST_BIAS = 3n` constant | Task 3 step 3 |
| ≥ 2% min-distribution invariant test on bid-ask | Task 2 step 1 |
| ≥ 2% min-distribution invariant test on curve | Task 3 step 1 |
| `package.json` 0.1.13 → 0.1.14 | Task 4 step 1 |
| `docker build --platform linux/amd64 + push` | Task 4 steps 3-5 |
| janus-app provision YAML bump | Task 5 |
| `secretvm-cli vm edit` on all 3 live VMs | Task 6 steps 2-4 |
| Branch from feat/advanced-strategies (NOT main, to preserve v0.1.13 work) | Task 1 step 2 |
| Test pre-existing tests still pass after the change | Task 3 step 5 |
| Verify success log signature (mint succeeds, no GS013) | Task 6 step 6 |

No gaps.

**Placeholder scan:** clean. Every step has concrete code or commands; no "TBD" or "appropriate" placeholders.

**Type consistency:**
- `INNERMOST_BIAS` and `OUTERMOST_BIAS` are both `bigint` (named `10n` and `3n`); both used in `bigint + bigint` arithmetic in their respective weight functions.
- `MIN = ONE / 50n` is `bigint`, used in `bigint >= bigint` comparison via `toBeGreaterThanOrEqual`.
- Image tag `v0.1.14` matches consistently across pitbot version bump, image build/push, janus-app provision YAML, and the compose file in Task 6.
- VM IDs (`cmqaod1dg00gmn0iqhcm2esrg`, `cmq9zxfny00f4n0iq8c323d4n`, `cmqeyve41007e31iq25303h88`) match the spec's rollout section.

All consistent.
