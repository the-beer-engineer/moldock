# MolDock — On-Chain Molecular Docking Verification

**Bitcoin Script covenants verify molecular docking energy calculations on-chain.**

MolDock is a distributed system where AI agents autonomously discover each other, negotiate work, and exchange BSV micro-payments for verifying molecular docking calculations. Every energy calculation is enforced by Bitcoin Script — the blockchain doesn't just record results, it *verifies the math*.

Built for the **Open Run Agentic Pay 2026** hackathon.

## How It Works

### The Problem
Molecular docking simulates how drug molecules bind to protein receptors. Traditional approaches rely on trusted servers — you submit a molecule, get a score back, and hope the math was done correctly.

### The Solution
MolDock puts the verification on-chain using Bitcoin Script covenants. Each docking calculation is a chain of transactions where:

1. **Genesis TX** — Creates a covenant UTXO encoding the molecule and initial state (score=0)
2. **Chain Step TXs** — Each TX evaluates one receptor atom against all ligand atoms. The covenant Script verifies:
   - Integer square root (isqrt) for distance calculation
   - Van der Waals energy: `10000 / dist²`
   - Electrostatic energy: `(q1 × q2) / dist`
   - Hydrogen bond detection: `-500` when matching atom types within range
   - Score accumulation matches the claimed batch total
3. **Payment TX** — The final chain step includes a payment output to the compute agent

The covenant uses `SIGHASH_SINGLE|ANYONECANPAY|FORKID (0xC3)` so compute agents can attach fee inputs without breaking the covenant signature.

### Two Autonomous Agents

**Dispatch Agent** — Posts bounties (genesis covenant TXs), distributes work to compute agents, verifies results, and pays rewards.

**Compute Agent** — Discovers the dispatch agent, requests work, executes covenant chains (computing energy in memory), and submits results to earn BSV.

The agents discover each other via HTTP (`/api/discover`), register, negotiate work packages, and exchange value through on-chain BSV transactions.

## Architecture

```
┌─────────────────┐         HTTP API          ┌──────────────────┐
│  Dispatch Agent  │◄────────────────────────►│  Compute Agent   │
│                  │                           │  (CLI or Browser)│
│  - Posts bounties│    /api/discover          │                  │
│  - Creates       │    /api/agent/register    │  - Discovers     │
│    genesis TXs   │    /api/agent/:id/work    │    dispatch      │
│  - Verifies      │    /api/agent/:id/pass    │  - Executes      │
│    results       │    /api/agent/:id/fail    │    chains        │
│  - Pays rewards  │    /api/agent/:id/confirm │  - Earns BSV     │
└────────┬────────┘                           └────────┬─────────┘
         │                                              │
         └──────────────┐          ┌───────────────────┘
                        ▼          ▼
               ┌────────────────────────┐
               │    BSV Blockchain      │
               │                        │
               │  Genesis TX (covenant) │
               │    ↓                   │
               │  Chain Step 1 (verify) │
               │    ↓                   │
               │  Chain Step 2 (verify) │
               │    ↓                   │
               │  ...                   │
               │    ↓                   │
               │  Chain Step N (pay)    │
               └────────────────────────┘
```

## Transaction Sizes

The covenant Script is substantial — it performs real mathematical verification:

| Component | Size |
|-----------|------|
| Covenant body (pairVerify × N atoms) | Appears TWICE in locking script |
| Chain step TX (62 atoms, typical) | ~4,500 bytes |
| Genesis TX (62 atoms) | ~3,900 bytes |
| ScriptSig (5 values × N atoms) | ~500-1,500 bytes |

For 1.5M TXs at ~4.5 KB average: **~6.75 GB of on-chain verified computation.**

## Quick Start

### Prerequisites
- Node.js 18+
- BSV node for regtest (or use testnet/mainnet via ARC)

### 1. Start the Dispatch Agent
```bash
cd agent
npm install
npm run dispatch
```

The dispatch agent will:
- Compile covenant scripts for all molecule sizes (~10s)
- Start HTTP server on port 3456
- Begin posting bounties automatically
- Serve the dashboard at http://localhost:3456

### 2. Connect Compute Agents

**Option A: Browser Agent (recommended)**
- Open http://localhost:3456 in your browser
- Click "Start Computing"
- Watch your agent earn BSV in real-time

**Option B: CLI Agent**
```bash
# In a new terminal
npm run compute -- --server http://localhost:3456 --name MyBot
```

**Option C: Multiple CLI Agents**
```bash
# Terminal 1
npm run compute -- --server http://localhost:3456 --name Bot1 --no-prompt
# Terminal 2
npm run compute -- --server http://localhost:3456 --name Bot2 --no-prompt
# Terminal 3
npm run compute -- --server http://localhost:3456 --name Bot3 --no-prompt
```

### 3. Watch the Dashboard

Open http://localhost:3456 to see:
- Real-time agent activity and earnings
- Transaction volume progress (1.5M target)
- Molecule leaderboard by docking score
- Event log of agent negotiations

## Configuration

Environment variables (`.env` or shell):

| Variable | Default | Description |
|----------|---------|-------------|
| `NETWORK` | `regtest` | `regtest`, `testnet`, or `mainnet` |
| `PORT` | `3456` | HTTP server port |
| `FEE_RATE_SATS_PER_KB` | `10` | Transaction fee rate |
| `DISPATCH_PRIVATE_KEY` | (random) | WIF private key for dispatch wallet |
| `COMPUTE_PRIVATE_KEY` | (random) | WIF private key for compute wallet |
| `AUTO_QUEUE_SIZE` | `10` | Molecules per auto-batch |

## Covenant Deep Dive

The covenant uses `SIGHASH_SINGLE|ANYONECANPAY|FORKID` (0xC3):

- **ANYONECANPAY**: `hashPrevouts` and `hashSequence` are all-zeros, allowing additional fee inputs without breaking the covenant signature
- **SIGHASH_SINGLE**: `hashOutputs` only covers output 0 (covenant continuation), allowing payment and change outputs

Each chain step's `pairVerify` block (repeated N times for N ligand atoms):
```
toAltStack          // save accumulator
swap dup            // distance
dup mul             // distance²
2 pick              // dsq (distance squared from scriptSig)
lessThanOrEqual verify  // verify isqrt: dist² ≤ dsq
1 add dup mul       // (dist+1)²
lessThan verify     // verify isqrt: (dist+1)² > dsq
add add             // accumulate vdw + elec + hbond
fromAltStack add    // add to running total
```

## Molecule Library

Uses the CDK2 (Cyclin-Dependent Kinase 2) dataset:
- **27 real drug molecules** (palbociclib, ribociclib, staurosporine, etc.)
- **20-88 atoms** per molecule (median: 48)
- **20 receptor atoms** = 20 chain steps per molecule
- Coordinates scaled ×100 for integer arithmetic

## Fee Budget

| Fee Rate | Fee/TX (~4.5KB) | 1.5M TXs Total | + Rewards | Budget |
|----------|-----------------|-----------------|-----------|--------|
| 3 sats/kB | ~14 sats | ~0.21 BSV | ~0.3 BSV | **~0.5 BSV** |
| 10 sats/kB | ~45 sats | ~0.68 BSV | ~0.3 BSV | **~1.0 BSV** |
| 50 sats/kB | ~225 sats | ~3.38 BSV | ~0.3 BSV | **~3.7 BSV** |

## Project Structure

```
moldock/
├── agent/
│   ├── src/
│   │   ├── dispatchAgent.ts   # Autonomous dispatch agent
│   │   ├── computeAgent.ts    # CLI compute agent
│   │   ├── dashboard.ts       # Dashboard + browser compute agent
│   │   ├── dispatch.ts        # Work distribution & verification
│   │   ├── chainBuilder.ts    # Covenant chain construction
│   │   ├── chainTemplate.ts   # .sx script generation (SIGHASH_SINGLE|ANYONECANPAY)
│   │   ├── energy.ts          # Energy computation (pure math)
│   │   ├── genesis.ts         # Genesis TX + .sx compilation
│   │   ├── wallet.ts          # BSV wallet (P2PK + P2PKH)
│   │   ├── network.ts         # Network adapter (regtest/ARC)
│   │   ├── config.ts          # Configuration
│   │   └── regtest.ts         # Regtest node interface
│   └── data/cdk2/             # CDK2 molecule library
├── scripts/
│   └── atomChain.sx           # Reference covenant script
└── README.md
```

## License

MIT
