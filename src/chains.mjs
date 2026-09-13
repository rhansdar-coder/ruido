// The chain registry.
//
// Adding a chain must be a data change, not a code change. That is the whole
// point of this file: the EVM indexer, the measurement and the report are all
// chain-agnostic, and everything chain-specific lives here.
//
// Every entry carries the two things that are easy to get wrong and expensive
// to get wrong quietly:
//
//   rpcs            - a list, because public endpoints rotate out. We rotate
//                     rather than retry, since a retry storm on a rate-limited
//                     endpoint makes the rate limiting worse.
//   systemAddresses - infrastructure that is written once per block. Left in the
//                     identity counts, an address like 0x…a4b05 becomes the most
//                     active "account" on the chain. This list is explicit
//                     rather than heuristic, and evm-corpus.mjs separately
//                     REPORTS any address whose transaction count equals the
//                     block count, so a missed entry is visible instead of
//                     silently inflating the numbers.
//
// blockTimeSeconds is a hint for sizing windows, not a source of truth. The
// indexer measures the real value from the blocks it fetched and the corpus
// carries it; `npm run blocktimes` measures it independently for every chain.

/** ERC-4337 EntryPoints. Universal, not chain-specific. */
export const ENTRYPOINTS = {
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789": "entrypoint-v0.6",
  "0x0000000071727de22e5e9d8baf0edac6f37da032": "entrypoint-v0.7",
};

// Infrastructure addresses, by chain family. These are precompiles and pseudo-
// addresses that the protocol itself writes to, not accounts anyone controls.
const ARBITRUM_SYSTEM = [
  "0x00000000000000000000000000000000000a4b05", // L1 block number pseudo-address
  "0x0000000000000000000000000000000000000064", // ArbSys
  "0x0000000000000000000000000000000000000065", // ArbInfo
  "0x0000000000000000000000000000000000000066", // ArbAddressTable
  "0x0000000000000000000000000000000000000067", // ArbGasInfo
  "0x000000000000000000000000000000000000006b", // ArbOwner
  "0x000000000000000000000000000000000000006c", // ArbWasm
  "0x000000000000000000000000000000000000006e", // ArbRetryableTx
  "0x000000000000000000000000000000000000006f", // ArbStatistics
];

const OP_STACK_SYSTEM = [
  "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001", // L1 attributes depositor
  "0x4200000000000000000000000000000000000015", // L1Block predeploy
  "0x4200000000000000000000000000000000000016", // L2ToL1MessagePasser
  "0x420000000000000000000000000000000000000f", // GasPriceOracle
];

const ETHEREUM_SYSTEM = [
  "0xfffffffffffffffffffffffffffffffffffffffe", // EIP-4788 beacon roots caller
  "0x000f3df6d732807ef1319fb7b8bb8522d0beac02", // beacon roots contract
];

export const CHAINS = {
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    family: "arbitrum-orbit",
    stack: "Arbitrum Orbit",
    blockTimeSeconds: 0.1017,
    rpcs: [
      "https://rpc.mainnet.chain.robinhood.com",
    ],
    systemAddresses: ARBITRUM_SYSTEM,
    note: "Tokenized equities for retail. No shielding primitive; the ecosystem "
      + "page lists TRM Labs under compliance and never mentions privacy.",
  },
  "robinhood-testnet": {
    key: "robinhood-testnet",
    name: "Robinhood Chain Testnet",
    chainId: 46630,
    family: "arbitrum-orbit",
    stack: "Arbitrum Orbit",
    blockTimeSeconds: 0.1017,
    rpcs: [
      "https://rpc.testnet.chain.robinhood.com",
    ],
    systemAddresses: ARBITRUM_SYSTEM,
    note: "The official docs list Chain ID 4663 for both networks. The testnet "
      + "reports 46630. The docs are wrong, and this registry says what the "
      + "chain says.",
  },
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    family: "op-stack",
    stack: "OP Stack",
    blockTimeSeconds: 2.0,
    rpcs: [
      "https://base-rpc.publicnode.com",
      "https://mainnet.base.org",
    ],
    systemAddresses: OP_STACK_SYSTEM,
    note: "Coinbase's L2. Largest L2 by DeFi TVL; the closest thing to a "
      + "high-volume general-purpose control.",
  },
  optimism: {
    key: "optimism",
    name: "Optimism",
    chainId: 10,
    family: "op-stack",
    stack: "OP Stack",
    blockTimeSeconds: 2.0,
    rpcs: [
      "https://optimism-rpc.publicnode.com",
    ],
    systemAddresses: OP_STACK_SYSTEM,
    note: "The reference OP Stack chain.",
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    family: "arbitrum-orbit",
    stack: "Arbitrum Nitro",
    blockTimeSeconds: 0.25,
    rpcs: [
      "https://arbitrum-one-rpc.publicnode.com",
    ],
    systemAddresses: ARBITRUM_SYSTEM,
    note: "Same stack as Robinhood Chain, at ~500M blocks. Useful as a "
      + "same-family comparison, and its block numbers are a reminder that a "
      + "'block window' means even less here than elsewhere.",
  },
  ethereum: {
    key: "ethereum",
    name: "Ethereum",
    chainId: 1,
    family: "l1",
    stack: "Ethereum L1",
    blockTimeSeconds: 12.0,
    rpcs: [
      "https://ethereum-rpc.publicnode.com",
    ],
    systemAddresses: ETHEREUM_SYSTEM,
    note: "Chosen as the POSITIVE CONTROL for the shielded-pool detector, "
      + "because Tornado Cash is deployed here and every other chain in this "
      + "registry can only ever make the detector answer 'no'. The control was "
      + "then measured, and it failed to be one: in the observed window the "
      + "0.1 ETH pool received 1 transfer and the TORN token 13. Tornado Cash is "
      + "deployed and effectively dormant, so a recent window cannot exercise "
      + "the detector at all. The proof that the detector can fire is a unit "
      + "test with a mixer-shaped fixture, not this chain. A live positive "
      + "control would need an archive node and a 2022-era window.",
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS);

/** Look up a chain, with an error that says what the valid options are. */
export function resolveChain(key) {
  const chain = CHAINS[key];
  if (!chain) {
    throw new Error(`unknown chain: ${key} (try ${CHAIN_KEYS.join(", ")})`);
  }
  return chain;
}

/**
 * Every system address across every chain.
 *
 * Used by the measurement, which must recognise infrastructure without being
 * told which chain it is looking at.
 */
export const ALL_SYSTEM_ADDRESSES = new Set(
  Object.values(CHAINS).flatMap((c) => c.systemAddresses),
);

/**
 * Is this address infrastructure rather than a person?
 *
 * Pass a chain key to check that chain's list. Omit it to check every chain's —
 * which is what the measurement needs, since a corpus can be measured without
 * the measurer being told which chain it came from.
 */
export function isSystemAddress(address, chainKey) {
  const value = String(address ?? "").toLowerCase();
  if (!value) return false;
  if (chainKey) {
    const chain = CHAINS[chainKey];
    return chain ? chain.systemAddresses.includes(value) : false;
  }
  return ALL_SYSTEM_ADDRESSES.has(value);
}
