export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/** Infra owners that must never be "scored" as holders: burn, AMM authorities, lockers. */
export const INFRA_OWNERS = new Set([
  "1nc1nerator11111111111111111111111111111111", // burn
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium V4 authority
  "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL", // Raydium CPMM authority
  "3ckQZncmgmS1aZCC5oJmyPTaT1zGzGMKZ7VGVV8h8T1r", // Meteora vault authority
])

/** Stables and majors: trading these is portfolio rotation, not a call. Excluded from the live strip. */
export const MAJOR_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // WBTC (Portal)
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // WETH (Portal)
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
]);
