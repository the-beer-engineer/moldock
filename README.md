# MolDock — On-Chain Molecular Docking Verification

**Bitcoin Script covenants verify molecular docking energy calculations on-chain.**

MolDock is a distributed system where autonomous AI agents discover each other, negotiate work, and exchange BSV micro-payments for verified molecular docking computations. Every energy calculation is enforced by Bitcoin Script — the blockchain doesn't just record results, it *verifies the math*.

Built for the **Open Run Agentic Pay 2026** hackathon.

---

## How BSV Is Used

### The Core Idea

Drug discovery requires computing how molecules bind to protein receptors. These "docking scores" involve Van der Waals forces, electrostatic interactions, and hydrogen bonds. Traditionally, you trust a server to compute these honestly. MolDock eliminates that trust by putting the verification math directly into Bitcoin Script.

**Every transaction in MolDock is a computation step. The blockchain doesn't just record scores — it verifies the physics.**

### Transaction Chain Architecture

Each molecule produces a chain of covenant transactions, where each link verifies one receptor atom's interaction with the entire ligand:

```
Genesis TX (score=0)
    │
    ├── Chain Step 1: receptor atom 0 vs all ligand atoms
    │   Script verifies: isqrt, VDW, electrostatic, H-bond, accumulation
    │
    ├── Chain Step 2: receptor atom 1 vs all ligand atoms
    │   Script verifies: isqrt, VDW, electrostatic, H-bond, accumulation
    │
    │   ... (one step per receptor atom, 14-28 steps)
    │
    └── Final Step + Payment: last receptor atom + reward output
        Compute agent receives BSV payment for verified work
```

### The Covenant: SIGHASH_SINGLE|ANYONECANPAY|FORKID (0xC3)

The covenant enforces a self-referencing spending constraint using `OP_PUSH_TX`:

- **ANYONECANPAY**: Allows compute agents to attach fee inputs without breaking the covenant signature. `hashPrevouts` and `hashSequence` become all-zeros, so additional inputs don't affect the signed hash.
- **SIGHASH_SINGLE**: Only output 0 (covenant continuation) is signed. This allows payment outputs (to the compute agent) and change outputs without breaking the covenant.
- **Self-reference**: The script contains its own code twice — once as push data for hash verification, once as executable code after `OP_CODESEPARATOR`. This ensures the spending transaction recreates the same covenant.

### What the Script Verifies (Per Atom Pair)

The `pairVerify` block runs once per ligand atom in each chain step. For a molecule with 48 atoms docked against a 20-atom receptor, that's 48 × 20 = 960 verified computations across the chain:

```
toAltStack          // save running accumulator
swap dup            // distance hint from scriptSig
dup mul             // dist²
2 pick              // dsq (precomputed distance squared)
lessThanOrEqual verify  // verify: dist² ≤ dsq
1 add dup mul       // (dist+1)²
lessThan verify     // verify: dsq < (dist+1)²  ← integer square root proof
add add             // accumulate vdw + elec + hbond for this pair
fromAltStack add    // add to running total
```

Each chain step verifies:
1. **Integer square root correctness**: `dist² ≤ dsq < (dist+1)²` — the compute agent provides `dist` as a hint, the Script verifies it brackets the true distance
2. **Energy accumulation**: VDW (Lennard-Jones 12-6), electrostatic (Coulomb with dielectric screening), and hydrogen bond (linear falloff for N/O/S donors) energies are summed per pair
3. **State transition**: `scoreOut == scoreIn + batchTotal` — the output score must equal the input score plus all pair energies computed in this step

**If any value is wrong, the transaction is invalid. No trusted third party required.**

### On-Chain Fee Economics

| Metric | Value |
|---|---|
| Average chain step TX | ~1.8 KB |
| Average genesis TX | ~4-8 KB |
| Configurable fee rate | 3-100 sats/kB |
| Cost per chain TX (10 sats/kB) | ~18 sats |
| Total for 1.5M TXs (10 sats/kB) | ~0.27 BSV fees + ~0.2 BSV rewards ≈ **0.5 BSV** |

---

## Agent Discovery & Work Execution

### How Agents Find Each Other

MolDock uses a **dispatch/compute** pattern where agents autonomously discover, negotiate, and transact:

```
Compute Agent                          Dispatch Agent
     │                                       │
     │  GET /api/discover                    │
     │──────────────────────────────────────>│
     │  { name, version, molecules, agents } │
     │<──────────────────────────────────────│
     │                                       │
     │  POST /api/agent/register             │
     │  { name, pubKey, handcash? }          │
     │──────────────────────────────────────>│
     │  { agentId, status: "registered" }    │
     │<──────────────────────────────────────│
     │                                       │
     │  GET /api/agent/:id/work              │
     │──────────────────────────────────────>│
     │  { molecule, genesisTxHex, receptor,  │
     │    compiledAsm, rewardSats }          │
     │<──────────────────────────────────────│
     │                                       │
     │  [builds covenant chain locally]      │
     │  [broadcasts TXs to BSV network]      │
     │                                       │
     │  POST /api/agent/:id/pass             │
     │  { moleculeId, chainTxids, score }    │
     │──────────────────────────────────────>│
     │  { reward: 300, txid: "abc..." }      │
     │<──────────────────────────────────────│
```

### Step-by-Step: What a Compute Agent Does

1. **Discovery** — Agent sends `GET /api/discover` to the dispatch server. Receives the system name, available molecule count, and current agent roster. No authentication required — any agent can join.

2. **Registration** — Agent registers with `POST /api/agent/register`, providing:
   - A display name
   - A BSV public key (generated in-browser or from a wallet)
   - An optional HandCash handle for reward payments

3. **Work Request** — Agent requests work via `GET /api/agent/:id/work`. Dispatch assigns the next available molecule and returns:
   - The molecule's 3D atom coordinates (from PubChem conformers)
   - The receptor binding site atoms (from PDB crystal structures)
   - The genesis TX hex (covenant UTXO with score=0)
   - The compiled covenant ASM (Bitcoin Script, parameterized for this molecule's atom count)
   - The reward amount in satoshis

4. **Chain Execution** — The agent builds the covenant chain locally:
   - For each receptor atom, computes energy interactions with all ligand atoms
   - Constructs a spending TX with the energy values in the scriptSig
   - The covenant Script in the UTXO verifies every value
   - Each TX spends the previous covenant output and creates a new one
   - The agent attaches a fee input from its own wallet (enabled by ANYONECANPAY)

5. **Broadcasting** — Each chain TX is broadcast to the BSV network:
   - On regtest: via local `bitcoin-cli`
   - On mainnet/testnet: via ARC API (`POST /v1/tx` with binary body)
   - The agent broadcasts directly — dispatch doesn't need to relay

6. **Result Submission** — Agent submits the completed chain:
   - **Pass** (`POST /api/agent/:id/pass`): chain TXIDs + final score. Dispatch doesn't need to re-verify — the on-chain Script already proved correctness.
   - **Fail** (`POST /api/agent/:id/fail`): agent's computed answer included for dispatch to spot-check. If the math is wrong, the agent gets banned.

7. **Payment** — Dispatch sends a BSV micro-payment to the agent:
   - **Pass reward**: 100 + (10 × chain steps) sats. A 20-step chain earns 300 sats.
   - **Fail reward**: 100 sats (honest failures are still compensated for compute work).
   - Payment is the final TX in the covenant chain, with the agent's pubkey as output 1.

### Trust Levels

Agents build trust through honest work:

| Level | Name | Requirement | Effect |
|---|---|---|---|
| 0 | NEW | Just registered | All fails are spot-checked |
| 1 | PROVEN | 5+ passes | Reduced spot-checking |
| 2 | TRUSTED | 20+ passes | Minimal spot-checking |
| -1 | BANNED | Submitted incorrect math | No more work assigned |

### Browser vs CLI Agents

**Browser Agent (Primary)** — Open the dashboard at `http://localhost:3456`, enter a name, click "Start Computing". The agent runs entirely in your browser tab:
- Generates a BSV keypair in-browser using `@bsv/sdk`
- Receives work packages via HTTP polling
- Computes energy calculations in JavaScript (pure math, no native dependencies)
- Builds and signs covenant transactions client-side
- Submits results back to dispatch
- Dashboard shows real-time earnings, current molecule, chain progress

**CLI Agent** — Same logic, headless operation:
```bash
npm run compute -- --server http://localhost:3456 --name MyBot
```

**Multiple Agents** — Run as many as you want. Each gets independent work assignments:
```bash
npm run compute -- --server http://localhost:3456 --name Bot1 --no-prompt &
npm run compute -- --server http://localhost:3456 --name Bot2 --no-prompt &
```

---

## Drug & Receptor Library

MolDock ships with **107 FDA-approved drugs** docked against **8 real protein targets**:

| Protein Target | PDB ID | Receptor Atoms | Chain Steps | Disease Area |
|---|---|---|---|---|
| CDK2 | 1AQ1 | 20 | 21 | Cancer (cell cycle) |
| EGFR | 1M17 | 18 | 19 | Cancer (lung, breast) |
| HIV-1 Protease | 1HVR | 24 | 25 | HIV/AIDS |
| SARS-CoV-2 Mpro | 6LU7 | 22 | 23 | COVID-19 |
| COX-2 | 3LN1 | 16 | 17 | Inflammation/pain |
| Estrogen Receptor | 3ERT | 14 | 15 | Breast cancer |
| BRAF V600E | 4RZV | 20 | 21 | Melanoma |
| Acetylcholinesterase | 1EVE | 28 | 29 | Alzheimer's |

Drugs include: Imatinib, Erlotinib, Tamoxifen, Ritonavir, Celecoxib, Donepezil, Roscovitine, and 100 more. All 3D conformers are downloaded from PubChem and docked using real binding site coordinates from the Protein Data Bank.

**Per full pass**: 2,227 transactions (107 molecules × variable chain lengths).
**For 1.5M TXs**: ~674 passes through the full library.

---

## Quick Start

### Prerequisites
- Node.js 18+
- For regtest: local BSV node (optional — testnet/mainnet use ARC)

### 1. Install & Configure

```bash
cd agent
npm install

# Copy environment template
cp ../.env.example ../.env

# Edit .env:
#   NETWORK=regtest        (or testnet / mainnet)
#   DISPATCH_PRIVATE_KEY=  (WIF key, or leave blank for ephemeral)
#   PORT=3456
```

### 2. Start the Dispatch Agent

```bash
npm run dispatch
```

The dispatch agent will:
- Print the wallet address (fund this on mainnet)
- Compile covenant scripts for all molecule sizes (~10s)
- Start the HTTP server and dashboard
- Begin posting bounties automatically

### 3. Connect Compute Agents

**Option A: Browser (recommended)**
- Open `http://localhost:3456` in your browser
- Enter a name and optional HandCash handle
- Click **Start Computing**
- Watch your agent earn BSV in real-time

**Option B: CLI**
```bash
npm run compute -- --server http://localhost:3456 --name MyBot
```

**Option C: Multiple Agents**
```bash
# Run as many as you like — each gets independent work
npm run compute -- --server http://localhost:3456 --name Bot1 --no-prompt &
npm run compute -- --server http://localhost:3456 --name Bot2 --no-prompt &
npm run compute -- --server http://localhost:3456 --name Bot3 --no-prompt &
```

### 4. Dashboard

The dashboard at `http://localhost:3456` shows:
- Run status banner (ETA to 1.5M TXs, elapsed time, TX rate)
- Agent leaderboard with earnings, trust levels, and current molecule
- Molecule results with receptor target and docking scores
- Real-time event log of agent negotiations
- Wallet balance and fund exhaustion warnings

---

## Network Modes

| Mode | Broadcasting | Funding | Use Case |
|---|---|---|---|
| `regtest` | Local bitcoin-cli | Auto (coinbase) | Development & testing |
| `testnet` | ARC API | Manual (pre-fund wallet) | Integration testing |
| `mainnet` | ARC API | Manual (pre-fund wallet) | Production / hackathon run |

ARC endpoints:
- Mainnet: `https://arcade-us-1.bsvb.tech`
- Testnet: `https://arcade-testnet-us-1.bsvb.tech`

Wallet balance is checked via WhatsOnChain API on mainnet/testnet.

---

## Configuration

Environment variables (`.env` or shell):

| Variable | Default | Description |
|---|---|---|
| `NETWORK` | `regtest` | `regtest`, `testnet`, or `mainnet` |
| `PORT` | `3456` | HTTP server port |
| `FEE_RATE_SATS_PER_KB` | `10` | Transaction fee rate (sats/kB) |
| `DISPATCH_PRIVATE_KEY` | *(random)* | WIF private key for dispatch wallet persistence |
| `AUTO_QUEUE_SIZE` | `10` | Molecules per auto-batch |
| `AUTO_QUEUE_INTERVAL_MS` | `5000` | Interval between batch postings |

---

## Architecture

```
+-------------------+         HTTP API          +--------------------+
|  Dispatch Agent   |<------------------------->|  Compute Agent     |
|                   |                           |  (Browser or CLI)  |
|  - Posts bounties |    /api/discover          |                    |
|  - Creates        |    /api/agent/register    |  - Discovers       |
|    genesis TXs    |    /api/agent/:id/work    |    dispatch        |
|  - Verifies       |    /api/agent/:id/pass    |  - Computes energy |
|    results        |    /api/agent/:id/fail    |  - Builds chains   |
|  - Pays rewards   |    /api/agent/:id/confirm |  - Earns BSV       |
+--------+----------+                           +---------+----------+
         |                                                |
         +----------------+          +--------------------+
                          v          v
                 +------------------------+
                 |    BSV Blockchain       |
                 |                        |
                 |  Genesis TX (score=0)  |
                 |    |                   |
                 |  Step 1: vs atom 0     |
                 |    |                   |
                 |  Step 2: vs atom 1     |
                 |    |   ...             |
                 |  Step N: vs atom N-1   |
                 |    (+ payment output)  |
                 +------------------------+
```

---

## Project Structure

```
moldock/
├── agent/
│   ├── src/
│   │   ├── dispatchAgent.ts    # Autonomous dispatch agent (entry point)
│   │   ├── computeAgent.ts     # CLI compute agent
│   │   ├── dashboard.ts        # Dashboard HTML + browser compute agent
│   │   ├── dispatch.ts         # Work distribution, verification, payment
│   │   ├── chainBuilder.ts     # Covenant chain construction
│   │   ├── chainTemplate.ts    # Bitcoin Script .sx generation (parameterized)
│   │   ├── energy.ts           # Energy computation (VDW, electrostatic, H-bond)
│   │   ├── genesis.ts          # Genesis TX creation + .sx compilation
│   │   ├── wallet.ts           # BSV wallet (P2PK, network-aware addresses)
│   │   ├── network.ts          # Network adapter (regtest / ARC testnet / ARC mainnet)
│   │   ├── broadcaster.ts      # TX broadcast helper
│   │   ├── realMolecules.ts    # 107 drugs, 8 receptors, PubChem downloader
│   │   ├── config.ts           # Configuration
│   │   ├── regtest.ts          # Local bitcoin-cli interface
│   │   ├── types.ts            # Shared type definitions
│   │   ├── compiler.ts         # BitcoinSX .sx script compiler
│   │   ├── pipeline.ts         # Pipelined work loop
│   │   ├── server.ts           # Standalone HTTP server (alternative entry)
│   │   ├── worker.ts           # Worker pool
│   │   ├── generate.ts         # Molecule library loader
│   │   ├── verifier.ts         # Score verification
│   │   └── test*.ts            # Regtest integration tests
│   ├── data/
│   │   └── library.json        # Unified drug library (107 molecules, 8 receptors)
│   └── package.json
├── scripts/
│   ├── atomChain.sx            # Reference covenant script
│   ├── atomPairBatch.sx        # Batch verification script
│   ├── moldock.sxProj.json     # BitcoinSX simulation project (single batch)
│   └── moldock-chain.sxProj.json  # BitcoinSX simulation project (chained)
├── .env.example
├── .gitignore
└── README.md
```

---

## On-Chain Verification

Every chain step TX can be independently verified on WhatsOnChain. The scriptSig contains the energy values (dsq, dist, vdw, elec, hbond per atom pair) and the scriptPubKey contains the covenant that verifies the math. If any value is wrong, the transaction is invalid.

To verify a chain step:
1. Decode the scriptSig — extract the distance, energy, and score values
2. Check the isqrt: `dist² ≤ dsq < (dist+1)²`
3. Check the accumulation: `vdw + elec + hbond` per pair, summed = batchTotal
4. Check the state transition: `scoreOut == scoreIn + batchTotal`
5. The covenant enforces all of this — invalid math = invalid TX

---

## BitcoinSX Simulation

The `scripts/` directory contains `.sxProj.json` files that can be loaded into [BitcoinSX](https://bitcoinsx.elas.network) to simulate the verification scripts:

- **moldock.sxProj.json** — Single batch verification (Roscovitine vs CDK2 His84)
- **moldock-chain.sxProj.json** — Chained additive scoring (5 steps, score 0 to 149,339)

These use real data: Roscovitine (a CDK2 inhibitor) with actual H-bond and electrostatic terms.

---

## License

MIT
