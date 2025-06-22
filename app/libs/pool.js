const { Program } = require("@coral-xyz/anchor");
const { BN, BorshCoder } = require("@coral-xyz/anchor");
const { Connection, LAMPORTS_PER_SOL, PublicKey } = require("@solana/web3.js");
const IDL = require("../IDL/pumpswap-idl.json");
const {
  connection,
  PUMP_AMM_PROGRAM_ID,
  WSOL_TOKEN_ACCOUNT,
} = require("../constants");
const {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_PROGRAM_ID_PUBKEY = new PublicKey(PUMP_PROGRAM_ID);

const program = new Program(IDL, { connection });

const getPoolsWithBaseMint = async (mintAddress) => {
  let response = null,
    is_err = true,
    cnt = 0;

  while (is_err) {
    if (cnt >= 3) break;
    try {
      response = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
        filters: [
          {
            memcmp: {
              offset: 43,
              bytes: mintAddress.toBase58(),
            },
          },
        ],
      });
      if (response.length > 0) {
        is_err = false;
      }
    } catch (err) {
      is_err = true;
    }
    cnt++;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (is_err) {
    throw new Error(`Can not get Token ${mintAddress.toBase58()} pool data`);
  }

  const mappedPools = response.map((pool) => {
    const data = Buffer.from(pool.account.data);
    const poolData = program.coder.accounts.decode("pool", data);
    return {
      address: pool.pubkey,
      is_native_base: false,
      poolData,
    };
  });

  return mappedPools;
};

const getPoolsWithQuoteMint = async (mintAddress) => {
  const response = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
    filters: [
      { dataSize: 211 },
      {
        memcmp: {
          offset: 75,
          bytes: mintAddress.toBase58(),
        },
      },
    ],
  });

  const mappedPools = response.map((pool) => {
    const data = Buffer.from(pool.account.data);
    const poolData = program.coder.accounts.decode("pool", data);
    return {
      address: pool.pubkey,
      is_native_base: true,
      poolData,
    };
  });

  return mappedPools;
};

const getPoolsWithBaseMintQuoteWSOL = async (mintAddress) => {
  const response = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
    filters: [
      { dataSize: 211 },
      {
        memcmp: {
          offset: 43,
          bytes: mintAddress.toBase58(),
        },
      },
      {
        memcmp: {
          offset: 75,
          bytes: WSOL_TOKEN_ACCOUNT.toBase58(),
        },
      },
    ],
  });

  const mappedPools = response.map((pool) => {
    const data = Buffer.from(pool.account.data);
    const poolData = program.coder.accounts.decode("pool", data);
    return {
      address: pool.pubkey,
      is_native_base: true,
      poolData,
    };
  });

  return mappedPools;
};

const getPriceAndLiquidity = async (pool) => {
  const wsolAddress = pool.poolData.poolQuoteTokenAccount;
  const tokenAddress = pool.poolData.poolBaseTokenAccount;
  let wsolBalance, tokenBalance;
  let is_err = true,
    cnt = 0;
  while (is_err) {
    if (cnt >= 3) break;
    try {
      wsolBalance = await connection.getTokenAccountBalance(wsolAddress);
      tokenBalance = await connection.getTokenAccountBalance(tokenAddress);
      is_err = false;
    } catch (err) {
      is_err = true;
    }
    cnt++;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const price = wsolBalance.value.uiAmount / tokenBalance.value.uiAmount;

  return {
    ...pool,
    price,
    reserves: {
      native: wsolBalance.value.uiAmount,
      token: tokenBalance.value.uiAmount,
    },
  };
};

const getPoolsWithPrices = async (mintAddress) => {
  const [poolsWithBaseMint] = await Promise.all([
    getPoolsWithBaseMint(mintAddress),
  ]);
  const pools = [...poolsWithBaseMint];

  const results = await Promise.all(pools.map(getPriceAndLiquidity));

  const sortedByHighestLiquidity = results.sort(
    (a, b) => b.reserves.native - a.reserves.native
  );

  return sortedByHighestLiquidity[0];
};

const calculateWithSlippageBuy = (amount, basisPoints) => {
  return amount - (amount * basisPoints) / 10000n;
};

const getBuyTokenAmount = async (solNum, mint) => {
  const solAmount = BigInt(solNum * LAMPORTS_PER_SOL);
  const pool_detail = await getPoolsWithPrices(mint);
  const sol_reserve = BigInt(
    Math.floor(pool_detail.reserves.native * LAMPORTS_PER_SOL)
  );
  const token_reserve = BigInt(
    Math.floor(pool_detail.reserves.token * 10 ** 6)
  );
  const product = sol_reserve * token_reserve;
  let new_sol_reserve = sol_reserve + solAmount;
  let new_token_reserve = product / new_sol_reserve + 1n;
  let amount_to_be_purchased = token_reserve - new_token_reserve;

  return amount_to_be_purchased;
};

const getBuyTokenAmountBuyPoolDetail = (solNum, pool_detail) => {
  const solAmount = BigInt(solNum * LAMPORTS_PER_SOL);
  const sol_reserve = BigInt(
    Math.floor(pool_detail.reserves.native * LAMPORTS_PER_SOL)
  );
  const token_reserve = BigInt(
    Math.floor(pool_detail.reserves.token * 10 ** 6)
  );
  const product = sol_reserve * token_reserve;
  let new_sol_reserve = sol_reserve + solAmount;
  let new_token_reserve = product / new_sol_reserve + 1n;
  let amount_to_be_purchased = token_reserve - new_token_reserve;

  return amount_to_be_purchased;
};

const getSnipePumpTokenAmount = async (solNum, mint) => {
  const solAmount = BigInt(solNum * LAMPORTS_PER_SOL);
  const pool_detail = await getPoolsWithPrices(mint);
  const sol_reserve = BigInt(
    Math.floor(pool_detail.reserves.native * LAMPORTS_PER_SOL)
  );
  if (pool_detail.reserves.native >= 150) {
    throw new Error("Reserves too high");
  }
  const token_reserve = BigInt(
    Math.floor(pool_detail.reserves.token * 10 ** 6)
  );
  const product = sol_reserve * token_reserve;
  let new_sol_reserve = sol_reserve + solAmount;
  let new_token_reserve = product / new_sol_reserve + 1n;
  let amount_to_be_purchased = token_reserve - new_token_reserve;

  return amount_to_be_purchased;
};

const getPumpSwapPool = async (mint) => {
  const pools = await getPoolsWithBaseMint(mint);
  return pools[0].address;
};

const pumpPoolAuthorityPDA = (baseMint) => {
  const programId = new PublicKey(
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
  );
  const [pumpPoolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), baseMint.toBuffer()],
    programId
  );
  return pumpPoolAuthority;
};

const CANONICAL_POOL_INDEX = 0;

const globalConfigPda = (programId = PUMP_AMM_PROGRAM_ID) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    programId
  );
};

const poolPda = (
  index,
  owner,
  baseMint,
  quoteMint,
  programId = PUMP_AMM_PROGRAM_ID
) => {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      new BN(index).toArrayLike(Buffer, "le", 2),
      owner.toBuffer(),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
    ],
    programId
  );
};

const lpMintPda = (pool, programId = PUMP_AMM_PROGRAM_ID) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), pool.toBuffer()],
    programId
  );
};

const lpMintAta = (lpMint, owner) => {
  return getAssociatedTokenAddressSync(
    lpMint,
    owner,
    true,
    TOKEN_2022_PROGRAM_ID
  );
};

const pumpPoolAuthorityPda = (mint, pumpProgramId = PUMP_PROGRAM_ID_PUBKEY) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mint.toBuffer()],
    pumpProgramId
  );
};

const canonicalPumpPoolPda = (
  mint,
  programId = PUMP_AMM_PROGRAM_ID,
  pumpProgramId = PUMP_PROGRAM_ID_PUBKEY
) => {
  const [pumpPoolAuthority] = pumpPoolAuthorityPda(mint, pumpProgramId);

  return poolPda(
    CANONICAL_POOL_INDEX,
    pumpPoolAuthority,
    mint,
    NATIVE_MINT,
    programId
  );
};

const pumpAmmEventAuthorityPda = (programId = PUMP_AMM_PROGRAM_ID) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId
  );
};

const getCoinCreatorVaultAuthorityPda = (coinCreator, programId) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), coinCreator.toBuffer()],
    programId
  );
};

const getCoinCreatorVaultAtaPda = (
  coinCreatorVaultAuthority,
  quoteTokenProgram,
  quoteMint
) => {
  const programId = new PublicKey([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11,
    90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
  ]);

  return PublicKey.findProgramAddressSync(
    [
      coinCreatorVaultAuthority.toBuffer(),
      quoteTokenProgram.toBuffer(),
      quoteMint.toBuffer(),
    ],
    programId
  );
};

async function main() {
  const mint = new PublicKey("AhtTjcSc5Y2mK89uAzMDj19oZpmJLWzFqxwknJo6pump");
  const pool_detail = await getPoolsWithPrices(mint);
  console.log(pool_detail);
  const coin_creator_vault_authority = getCoinCreatorVaultAuthorityPda(
    pool_detail.poolData.coinCreator,
    PUMP_AMM_PROGRAM_ID
  );
  console.log(
    "coin_creator_vault_authority: ",
    coin_creator_vault_authority[0].toBase58()
  );
  const coin_creator_vault_ata = getCoinCreatorVaultAtaPda(
    coin_creator_vault_authority[0],
    TOKEN_PROGRAM_ID,
    NATIVE_MINT
  );
  console.log("coin_creator_vault_ata: ", coin_creator_vault_ata[0].toBase58());
}

// main();

module.exports = {
  getPoolsWithPrices,
  getCoinCreatorVaultAuthorityPda,
  getCoinCreatorVaultAtaPda,
  getBuyTokenAmount,
  getBuyTokenAmountBuyPoolDetail,
  getPoolsWithBaseMint,
  getPriceAndLiquidity,
};
