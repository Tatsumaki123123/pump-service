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

const {
  bnLayoutFormatter,
  reverseBnLayoutFormatter,
} = require("../utils/utils");

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_PROGRAM_ID_PUBKEY = new PublicKey(PUMP_PROGRAM_ID);

const program = new Program(IDL, { connection });

function decodePoolAccount(data) {
  const accountData = Buffer.from(data);
  try {
    return program.coder.accounts.decode("Pool", accountData);
  } catch (error) {
    // Older deployed IDLs may contain the Pool type but omit the account
    // registration. Decode the bytes after the 8-byte Anchor discriminator
    // directly through the type coder in that case.
    const errorMessage = String(error?.message || error).toLowerCase();
    if (!errorMessage.includes("account not found")) {
      throw error;
    }
    if (typeof program.coder.types?.decode === "function") {
      let typeError;
      for (const typeName of ["Pool", "pool"]) {
        try {
          return program.coder.types.decode(typeName, accountData.subarray(8));
        } catch (decodeError) {
          typeError = decodeError;
        }
      }
      if (typeError) throw typeError;
    }
    throw error;
  }
}

const getPoolsWithBaseMint = async (mintAddress, ctx) => {
  const dbData = await ctx.model.PoolStore.findOne({
    token: mintAddress.toBase58(),
  });
  if (dbData && dbData.poolObj) {
    const poolData = reverseBnLayoutFormatter(dbData.poolObj);
    const poolAddress = new PublicKey(dbData.pool);

    try {
      const accountInfo = await connection.getAccountInfo(
        poolAddress,
        "confirmed",
      );
      if (accountInfo && accountInfo.data.length > 8) {
        // Pool fields such as coinCreator are part of the on-chain account.
        // A cached poolObj can predate a pool layout/update, which produces a
        // wrong coin_creator_vault_authority PDA during a swap. Always decode
        // the current account when it is available and retain the cache only
        // as a fallback for transient RPC failures.
        const freshPoolData = decodePoolAccount(accountInfo.data);
        if (accountInfo.data.length > 244) {
          freshPoolData.is_mayhem = accountInfo.data[243] === 1;
          freshPoolData.is_cashback = accountInfo.data[244] === 1;
        }
        if (ctx?.model?.PoolStore) {
          try {
            await ctx.model.PoolStore.updateOne(
              { token: mintAddress.toBase58() },
              { $set: { poolObj: bnLayoutFormatter(freshPoolData) } },
            );
          } catch (error) {
            console.log(
              "Failed to update cached Pump AMM pool " +
                poolAddress.toBase58() +
                ": " +
                error.message,
            );
          }
        }
        return {
          address: poolAddress,
          is_native_base: false,
          poolData: freshPoolData,
        };
      }
    } catch (error) {
      console.log(
        "Failed to refresh Pump AMM pool " +
          poolAddress.toBase58() +
          ": " +
          error.message,
      );
    }

    return {
      address: poolAddress,
      is_native_base: false,
      poolData,
    };
  } else {
    let response = null,
      is_err = true,
      cnt = 0;

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

    if (is_err) {
      throw new Error(`Can not get Token ${mintAddress.toBase58()} pool data`);
    }
    const mappedPools = response.map((pool) => {
      const data = Buffer.from(pool.account.data);
      const poolData = decodePoolAccount(data);
      // IDL 未包含 is_mayhem/is_cashback，从原始字节读取
      // pool struct 字节布局: 8(discriminator)+1+2+32+32+32+32+32+32+8+32 = 243
      poolData.is_mayhem = data[243] === 1;
      poolData.is_cashback = data[244] === 1;
      return {
        address: pool.pubkey,
        is_native_base: false,
        poolData,
      };
    });
    const pool = mappedPools.find((item) =>
      NATIVE_MINT.equals(item.poolData.quoteMint),
    );

    if (pool) {
      const newPoolData = bnLayoutFormatter(pool.poolData);
      await ctx.model.PoolStore.create({
        token: mintAddress.toBase58(),
        pool: pool.address.toBase58(),
        poolObj: newPoolData,
      });
      return pool;
    } else {
      throw new Error("Cannot find pump pool");
    }
  }
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
    const poolData = decodePoolAccount(data);
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
    const poolData = decodePoolAccount(data);
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
  try {
    [wsolBalance, tokenBalance] = await Promise.all([
      connection.getTokenAccountBalance(wsolAddress),
      connection.getTokenAccountBalance(tokenAddress),
    ]);
    is_err = false;
  } catch (err) {
    is_err = true;
  }
  if (is_err) {
    throw new Error("get pool and lp error");
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

const getPoolsWithPrices = async (mintAddress, ctx) => {
  const poolsWithBaseMint = await getPoolsWithBaseMint(mintAddress, ctx);
  const result = await getPriceAndLiquidity(poolsWithBaseMint);
  return result;
  const pools = [...poolsWithBaseMint];

  const results = await Promise.all(pools.map(getPriceAndLiquidity));

  const sortedByHighestLiquidity = results.sort(
    (a, b) => b.reserves.native - a.reserves.native,
  );

  return sortedByHighestLiquidity[0];
};

const calculateWithSlippageBuy = (amount, basisPoints) => {
  return amount - (amount * basisPoints) / 10000n;
};

const getBuyTokenAmount = async (solNum, mint) => {
  const solAmount = BigInt(parseInt(solNum * LAMPORTS_PER_SOL));
  const pool_detail = await getPoolsWithPrices(mint);
  const sol_reserve = BigInt(
    Math.floor(pool_detail.reserves.native * LAMPORTS_PER_SOL),
  );
  const token_reserve = BigInt(
    Math.floor(pool_detail.reserves.token * 10 ** 6),
  );
  const product = sol_reserve * token_reserve;
  let new_sol_reserve = sol_reserve + solAmount;
  let new_token_reserve = product / new_sol_reserve + 1n;
  let amount_to_be_purchased = token_reserve - new_token_reserve;

  return amount_to_be_purchased;
};

const getBuyTokenAmountBuyPoolDetail = (solNum, pool_detail) => {
  const solAmount = BigInt(parseInt(solNum * LAMPORTS_PER_SOL));
  const sol_reserve = BigInt(
    Math.floor(pool_detail.reserves.native * LAMPORTS_PER_SOL),
  );
  const token_reserve = BigInt(
    Math.floor(pool_detail.reserves.token * 10 ** 6),
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
    Math.floor(pool_detail.reserves.native * LAMPORTS_PER_SOL),
  );
  if (pool_detail.reserves.native >= 150) {
    throw new Error("Reserves too high");
  }
  const token_reserve = BigInt(
    Math.floor(pool_detail.reserves.token * 10 ** 6),
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
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  );
  const [pumpPoolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), baseMint.toBuffer()],
    programId,
  );
  return pumpPoolAuthority;
};

const CANONICAL_POOL_INDEX = 0;

const globalConfigPda = (programId = PUMP_AMM_PROGRAM_ID) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    programId,
  );
};

const poolPda = (
  index,
  owner,
  baseMint,
  quoteMint,
  programId = PUMP_AMM_PROGRAM_ID,
) => {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      new BN(index).toArrayLike(Buffer, "le", 2),
      owner.toBuffer(),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
    ],
    programId,
  );
};

const lpMintPda = (pool, programId = PUMP_AMM_PROGRAM_ID) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), pool.toBuffer()],
    programId,
  );
};

const lpMintAta = (lpMint, owner) => {
  return getAssociatedTokenAddressSync(
    lpMint,
    owner,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
};

const pumpPoolAuthorityPda = (mint, pumpProgramId = PUMP_PROGRAM_ID_PUBKEY) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mint.toBuffer()],
    pumpProgramId,
  );
};

const canonicalPumpPoolPda = (
  mint,
  programId = PUMP_AMM_PROGRAM_ID,
  pumpProgramId = PUMP_PROGRAM_ID_PUBKEY,
) => {
  const [pumpPoolAuthority] = pumpPoolAuthorityPda(mint, pumpProgramId);

  return poolPda(
    CANONICAL_POOL_INDEX,
    pumpPoolAuthority,
    mint,
    NATIVE_MINT,
    programId,
  );
};

const pumpAmmEventAuthorityPda = (programId = PUMP_AMM_PROGRAM_ID) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId,
  );
};

const getCoinCreatorVaultAuthorityPda = (coinCreator, programId) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), coinCreator.toBuffer()],
    programId,
  );
};

const getCoinCreatorVaultAtaPda = (
  coinCreatorVaultAuthority,
  quoteTokenProgram,
  quoteMint,
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
    programId,
  );
};

async function main() {
  const mint = new PublicKey("AhtTjcSc5Y2mK89uAzMDj19oZpmJLWzFqxwknJo6pump");
  const pool_detail = await getPoolsWithPrices(mint);
  console.log(pool_detail);
  const coin_creator_vault_authority = getCoinCreatorVaultAuthorityPda(
    pool_detail.poolData.coinCreator,
    PUMP_AMM_PROGRAM_ID,
  );
  console.log(
    "coin_creator_vault_authority: ",
    coin_creator_vault_authority[0].toBase58(),
  );
  const coin_creator_vault_ata = getCoinCreatorVaultAtaPda(
    coin_creator_vault_authority[0],
    TOKEN_PROGRAM_ID,
    NATIVE_MINT,
  );
  console.log("coin_creator_vault_ata: ", coin_creator_vault_ata[0].toBase58());
}

function getUserVolumeAccumulatorPda(user) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  )[0];
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
  getUserVolumeAccumulatorPda,
};
