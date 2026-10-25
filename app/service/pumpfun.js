const { Service } = require("egg");
const {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionMessage,
  TransactionInstruction,
  Transaction,
} = require("@solana/web3.js");
const { AnchorProvider, Wallet } = require("@coral-xyz/anchor");

const {
  testWallet,
  connection,
  FOMO_RECEIVE_ADDRESS,
  FOMO_TRANSFER_LAMPORTS,
} = require("../constants");

const { PumpFunSDK, GlobalAccount } = require("../libs/pumpfun");
const {
  createAxiomPumpfunBuyInstructions,
} = require("../libs/axiom");
const OKXSwapSDK = require("../libs/okxRouterV2");
const { createTroProxyInstruction } = require("../libs/trogan");
const {
  PADRE_FEE_RECIPIENT,
  PADRE_FEE_BASIS_POINTS,
  createPadreRouteInstruction,
  createPadreNonceInstructions,
  getPadreNonceAccount,
  getPadreSwapAccounts,
} = require("../libs/padre");
const {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} = require("@solana/spl-token");

const { sendV0Transaction, getSPLBalance } = require("../utils/solana");
const { splitIntoBundles } = require("../utils/utils");
const chalk = require("chalk");

const provider_wallet = new Wallet(new Keypair());
const provider = new AnchorProvider(connection, provider_wallet, {
  commitment: "finalized",
});

const pfSwap = new PumpFunSDK(provider);
const okxSwap = new OKXSwapSDK();

const TIP_ACCOUNT = new PublicKey(
  "6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK"
);
const PUMP_FUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);
const GMGN_PROGRAM_ID = new PublicKey(
  "GMgnVFR8Jb39LoXsEVzb3DvBy3ywCmdmJquHUy1Lrkqb",
);
const GMGN_SERVICE_FEE_ACCOUNT = new PublicKey(
  "DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx",
);
const GMGN_REFERRAL_FEE_ACCOUNT = new PublicKey(
  "EeCSgSgNE1dTX5vbyJN5Mgz3eVUW9ZJfLP8QGYzKWDrH",
);
const GMGN_SERVICE_FEE_LAMPORTS = 10_000;
const GMGN_REFERRAL_FEE_LAMPORTS = 10_000;
const SLIPPAGE_BASIS_POINTS = 5000n;

function createPadrePumpFunHopKeys(buyInstruction, inputTokenAccount) {
  const keys = buyInstruction.keys;
  if (keys.length < 18) {
    throw new Error("Pump.fun buy instruction is missing Padre route accounts");
  }
  const readonly = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
  return [
    readonly(PUMP_FUN_PROGRAM_ID),
    keys[3],
    keys[0],
    keys[2],
    readonly(NATIVE_MINT),
    { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
    { ...keys[5], isSigner: false },
    { ...keys[1], isSigner: false },
    keys[17],
    keys[4],
    keys[9],
    keys[10],
    keys[12],
    readonly(keys[15].pubkey),
  ];
}

function isDevelopmentEnvironment(ctx) {
  const env = String(
    ctx?.app?.config?.env || process.env.NODE_ENV || "",
  ).toLowerCase();
  return env === "local" || env === "dev" || env === "development";
}

function getWalletSlippageBasisPoints(wallet) {
  if (wallet?.slippage === undefined || wallet?.slippage === null) {
    return SLIPPAGE_BASIS_POINTS;
  }
  const slippage = Number(wallet.slippage);
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 1) {
    throw new Error("slippage must be between 0 and 1");
  }
  return BigInt(Math.floor(slippage * 10000));
}

async function simulatePumpFunTransaction(transaction, user, ctx) {
  if (!isDevelopmentEnvironment(ctx)) {
    return null;
  }
  const simulationResult = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  if (simulationResult.value.err) {
    const logs = simulationResult.value.logs?.join("\n") || "no program logs";
    throw new Error(
      `Pump.fun simulation failed for ${user.toBase58()}: ${JSON.stringify(
        simulationResult.value.err,
      )}\n${logs}`,
    );
  }
  console.log(chalk.green("Pump.fun simulation success", user.toBase58()));
  return simulationResult.value;
}

function createGmgnPumpfunBuyInstructions(
  instructions,
  tokenMint,
  solAmountLamports,
  slippageBasisPoints,
) {
  const bondingCurveV2 = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve-v2"), tokenMint.toBuffer()],
    PUMP_FUN_PROGRAM_ID,
  )[0];
  let replaced = false;
  const nextInstructions = instructions.map((instruction) => {
    if (!instruction.programId.equals(PUMP_FUN_PROGRAM_ID)) {
      return instruction;
    }
    if (instruction.data.length !== 24) {
      return instruction;
    }
    const keys = instruction.keys.map((key) => ({ ...key }));
    if (keys.length < 17) {
      return instruction;
    }
    keys[16].pubkey = bondingCurveV2;
    const expectedTokenAmount = instruction.data.readBigUInt64LE(8);
    const minTokenAmount =
      (expectedTokenAmount * (10_000n - slippageBasisPoints)) / 10_000n;
    const data = Buffer.from(instruction.data);
    data.writeBigUInt64LE(BigInt(solAmountLamports), 8);
    data.writeBigUInt64LE(minTokenAmount, 16);
    replaced = true;
    return new TransactionInstruction({
      programId: GMGN_PROGRAM_ID,
      keys,
      data,
    });
  });

  if (!replaced) {
    throw new Error("Could not find Pump.fun buy instruction for GMGN route");
  }
  return nextInstructions;
}

class PumpFun extends Service {
  constructor(ctx) {
    super(ctx);
    this.buyTimer = null;
    this.canBuy = true;
  }
  async buyToken(token, amount = 0.01) {
    try {
      // if (!this.canBuy) return false;
      // this.canBuy = false;
      console.log(
        chalk.green("Buy token", token, testWallet.publicKey.toBase58())
      );
      const buyTx = await pfSwap.buy(
        testWallet.publicKey,
        new PublicKey(token),
        BigInt(amount * LAMPORTS_PER_SOL),
        SLIPPAGE_BASIS_POINTS,
        {
          unitLimit: 250000,
          unitPrice: 250000,
        },
        "processed"
      );
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      const messageV0 = new TransactionMessage({
        payerKey: testWallet.publicKey,
        recentBlockhash: blockhash,
        instructions: buyTx.instructions,
      }).compileToV0Message();
      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([testWallet]);
      await simulatePumpFunTransaction(transaction, testWallet.publicKey, ctx);
      const signature = await connection.sendTransaction(transaction, {
        skipPreflight: !isDevelopmentEnvironment(ctx),
        maxRetries: 2,
      });
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "processed",
      );
      console.log(`https://solscan.io/tx/${signature}`);
      return true;
    } catch (error) {
      console.error(error);
    }
  }

  async quickBuyToken(tokenData, amount = 0.01) {
    const { ctx } = this;
    const { mint, creator } = tokenData;
    const buyTx = await pfSwap.getQuickBuyInstructions(
      testWallet.publicKey,
      mint,
      creator,
      BigInt(amount * LAMPORTS_PER_SOL),
      SLIPPAGE_BASIS_POINTS,
      {
        unitLimit: 250000,
        unitPrice: 250000,
      },
      "processed"
    );
    //  const tipIx = SystemProgram.transfer({
    //     fromPubkey: testWallet.publicKey,
    //     toPubkey: new PublicKey("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49"),
    //     lamports: 0.0001 * LAMPORTS_PER_SOL,
    //   });
    //   const volumeIxs = [tipIx, ...buyTx.instructions];
    // const volumeIxs = [...buyTx.instructions];

    const tipIx = SystemProgram.transfer({
      fromPubkey: testWallet.publicKey,
      toPubkey: ctx.service.jito.getTipAcc(),
      lamports: ctx.service.jito.getTipAmount(),
    });
    const volumeIxs = [tipIx, ...buyTx.instructions];

    const { blockhash } = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: testWallet.publicKey,
      recentBlockhash: blockhash,
      instructions: volumeIxs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([testWallet]);
    await simulatePumpFunTransaction(tx, testWallet.publicKey, ctx);
    // const volumeIxs = [...buyTx.instructions];
    const bundleResult = await ctx.service.jito.sendBundle([tx]);
    console.log(bundleResult);

    // const res = await sendV0Transaction(connection, testWallet, volumeIxs);
    return true;
  }

  async sellToken(token, amount) {
    try {
      const { ctx } = this;
      console.log(chalk.green("Sell token", token));
      const tokenMint = new PublicKey(token);
      const currentSPLBalance = await getSPLBalance(
        connection,
        tokenMint,
        testWallet.publicKey
      );
      if (currentSPLBalance) {
        let sellTx = await pfSwap.sell(
          testWallet.publicKey,
          tokenMint,
          BigInt(Math.trunc(currentSPLBalance * Math.pow(10, 6))),
          SLIPPAGE_BASIS_POINTS,
          {
            unitLimit: 250000,
            unitPrice: 250000,
          },
          "processed"
        );
        const res = await sendV0Transaction(
          testWallet,
          sellTx.instructions
        );
        return true;
      } else {
        console.error("No token amount");
      }
    } catch (error) {
      console.error(error);
    }
  }

  async batchBuyToken(token, wallets, type = "", sendOptions = {}) {
    const { ctx } = this;
    console.log(chalk.green("\nPump fun batchBuyToken----", wallets.length));
    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      const isNozomi =
        String(sendOptions.batchPlatform || "").toLowerCase() === "nozomi";
      const { blockhash } = await connection.getLatestBlockhash();
      const buyTxns = [];
      const allAxiomWallets = wallets.every((wallet) => wallet.isAxiom);
      let batchAxiomCurveAccount = null;
      let sequentialAxiomBuyPrices = null;
      if (allAxiomWallets) {
        batchAxiomCurveAccount = await pfSwap.getBondingCurveAccount(
          tokenMint,
          "processed",
        );
        if (!batchAxiomCurveAccount) {
          throw new Error(`Bonding curve account not found: ${token}`);
        }
        const quoteAmounts = wallets.map((wallet) => {
          const totalQuoteLamports = BigInt(
            Math.trunc(Number(wallet.buyAmount) * LAMPORTS_PER_SOL),
          );
          const platformFeeLamports = BigInt(
            Math.trunc(
              wallet.axiomFeeLamports == null
                ? Number(process.env.AXIOM_PLATFORM_FEE_LAMPORTS || 100000)
                : Number(wallet.axiomFeeLamports),
            ),
          );
          return totalQuoteLamports - platformFeeLamports;
        });
        if (quoteAmounts.some((amount) => amount <= 0n)) {
          throw new Error("Axiom Pump.fun buy amount must exceed the platform fee");
        }
        // A bundle executes these buys sequentially against the same curve.
        // Calculate each quote from the state left by the previous buy.
        sequentialAxiomBuyPrices = batchAxiomCurveAccount.getBuyPrices(quoteAmounts);
      }
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const { buyAmount, limit, price, fee } = wallet;
        const slippageBasisPoints = getWalletSlippageBasisPoints(wallet);
        let volumeIxs = [];
        console.log(`${user.toBase58()} buy ${buyAmount} ${token}`);
        if (wallet.isGmgn) {
          const solAmountLamports = BigInt(
            Math.trunc(buyAmount * LAMPORTS_PER_SOL),
          );
          const buyTx = await pfSwap.buy(
            user,
            tokenMint,
            solAmountLamports,
            slippageBasisPoints,
            {
              unitLimit: limit,
              unitPrice: price,
            },
            "processed",
          );
          volumeIxs = [
            // pfSwap.buy already prepends the configured compute budget
            // instructions. Keep them in their original order and only
            // replace the Pump.fun buy instruction with the GMGN wrapper.
            ...createGmgnPumpfunBuyInstructions(
              buyTx.instructions,
              tokenMint,
              solAmountLamports,
              slippageBasisPoints,
            ),
            SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: GMGN_SERVICE_FEE_ACCOUNT,
              lamports: GMGN_SERVICE_FEE_LAMPORTS,
            }),
            SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: GMGN_REFERRAL_FEE_ACCOUNT,
              lamports: GMGN_REFERRAL_FEE_LAMPORTS,
            }),
          ];
        } else if (wallet.isOkx) {
          const okxIxs = await okxSwap.getLocalBuyInstructions(ctx, {
            user,
            tokenMint,
            buyAmount,
            slippage: Number(slippageBasisPoints) / 10_000,
          });
          volumeIxs = [
            ...(limit
              ? [ComputeBudgetProgram.setComputeUnitLimit({ units: limit })]
              : []),
            ...(price
              ? [
                  ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: price,
                  }),
                ]
              : []),
            ...okxIxs,
          ];
        } else if (wallet.isAxiom) {
          const curveAccount =
            batchAxiomCurveAccount ||
            (await pfSwap.getBondingCurveAccount(tokenMint, "processed"));
          const axiomBuy = await createAxiomPumpfunBuyInstructions({
            tokenMint,
            user,
            buyAmount,
            curveAccount,
            feeLamports: wallet.axiomFeeLamports,
            expectedBaseAmountOverride: allAxiomWallets
              ? sequentialAxiomBuyPrices[i]
              : undefined,
          });
          volumeIxs = [
            ...(limit
              ? [ComputeBudgetProgram.setComputeUnitLimit({ units: limit })]
              : []),
            ...(price
              ? [
                  ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: price,
                  }),
                ]
              : []),
            ...axiomBuy.instructions,
            axiomBuy.feeInstruction,
          ];
        } else if (wallet.isPadre || wallet.isPardre) {
          const buyTx = await pfSwap.buy(
            user,
            tokenMint,
            BigInt(Math.trunc(buyAmount * LAMPORTS_PER_SOL)),
            slippageBasisPoints,
            {
              unitLimit: limit,
              unitPrice: price,
            },
            "processed",
          );
          const buyInstruction = buyTx.instructions.find((instruction) =>
            instruction.programId.equals(PUMP_FUN_PROGRAM_ID),
          );
          if (!buyInstruction) {
            throw new Error("Could not find Pump.fun buy instruction for Padre route");
          }
          const mintInfo = await connection.getAccountInfo(tokenMint, "processed");
          if (!mintInfo) {
            throw new Error(`Mint account not found: ${tokenMint.toBase58()}`);
          }
          const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
            ? TOKEN_2022_PROGRAM_ID
            : TOKEN_PROGRAM_ID;
          const { inputTokenAccount, outputTokenAccount } = getPadreSwapAccounts(
            user,
            tokenMint,
            tokenProgramId,
          );
          const expectedTokenAmount = buyInstruction.data.readBigUInt64LE(8);
          const minTokenAmount =
            (expectedTokenAmount * (10_000n - slippageBasisPoints)) / 10_000n;
          const routeInstruction = createPadreRouteInstruction({
            user,
            inputAmount: BigInt(Math.trunc(buyAmount * LAMPORTS_PER_SOL)),
            minFinalOut: minTokenAmount,
            inputTokenAccount,
            outputTokenAccount,
            outputMint: tokenMint,
            hopProtocol: 21,
            hopKeys: createPadrePumpFunHopKeys(
              buyInstruction,
              inputTokenAccount,
            ),
            feeBasisPoints: PADRE_FEE_BASIS_POINTS,
            feeRecipient: PADRE_FEE_RECIPIENT,
          });
          const nonceAccount = getPadreNonceAccount(user);
          const nonceInfo = await connection.getAccountInfo(
            nonceAccount,
            "confirmed",
          );
          volumeIxs = [
            ...buyTx.instructions.filter((instruction) =>
              instruction.programId.equals(ComputeBudgetProgram.programId),
            ),
            ...createPadreNonceInstructions(user, undefined, !!nonceInfo),
            routeInstruction,
          ];
        } else {
          const buyTx = await pfSwap.buy(
            user,
            tokenMint,
            BigInt(buyAmount * LAMPORTS_PER_SOL),
            slippageBasisPoints,
            {
              unitLimit: limit,
              unitPrice: price,
            },
            "processed"
          );
          volumeIxs = [...buyTx.instructions];
        }

        const jipAcc = ctx.service.jito.getTipAcc(sendOptions);
        const tipAmount = ctx.service.jito.getTipAmount(sendOptions);
        if (!wallet.isAxiom && !wallet.isGmgn && wallet.isFomo) {
          volumeIxs.push(
            SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: FOMO_RECEIVE_ADDRESS,
              lamports: FOMO_TRANSFER_LAMPORTS,
            }),
          );
        }
        if (
          !wallet.isAxiom &&
          !wallet.isGmgn &&
          (wallet.isTrogan || wallet.isTragon)
        ) {
          const troganTipIx = createTroProxyInstruction(
            user,
            jipAcc,
            undefined,
            { includeJitoDontFront: i === 0 },
          );
          if (troganTipIx) {
            volumeIxs.push(troganTipIx);
          }
        }

        if (!wallet.isPadre && !wallet.isPardre && !isNozomi && i === 0) {
          const configuredTipLamports = Number(fee) * LAMPORTS_PER_SOL;
          volumeIxs.push(
            SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: jipAcc,
              lamports:
                Number.isFinite(configuredTipLamports) &&
                configuredTipLamports > 0
                  ? configuredTipLamports
                  : tipAmount,
            }),
          );
        }

        if (
          isNozomi &&
          !wallet.isAxiom &&
          !wallet.isGmgn &&
          !wallet.isPadre &&
          !wallet.isPardre
        ) {
          volumeIxs.push(
            SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: jipAcc,
              lamports: tipAmount,
            }),
          );
        }

        try {
          const messageV0 = new TransactionMessage({
            payerKey: user,
            recentBlockhash: blockhash,
            instructions: volumeIxs,
          }).compileToV0Message();

          const tx = new VersionedTransaction(messageV0);
          tx.sign([keypair]);
          await simulatePumpFunTransaction(tx, user, ctx);
          buyTxns.push(tx);
        } catch (error) {
          console.error(error.message);
          break;
        }
      }
      console.log("buyTxns", buyTxns.length);
      if (buyTxns.length > 0) {
        // for (let i = 0; i < buyTxns.length; i++) {
        //   console.log("buy txn -", i);
        //   const transferTx = buyTxns[i];
        //   const signature = await connection.sendTransaction(transferTx, {
        //     skipPreflight: false,
        //   });
        //   await connection.confirmTransaction(signature, "processed");
        // }
        // return;
        if (buyTxns.length === 1 && !isNozomi) {
          const transferTx = buyTxns[0];
          const signature = await connection.sendTransaction(transferTx, {
            skipPreflight: !isDevelopmentEnvironment(ctx),
          });
          await connection.confirmTransaction(signature, "processed");
          return true;
        }
        const bundleResult = await ctx.service.jito.sendBundle(
          buyTxns,
          sendOptions,
        );
        console.log(bundleResult);
        console.log(chalk.green("Buy transactions completed."));
        return true;
      }
    } else {
      throw new Error("batchBuyToken: param error");
    }
  }

  async batchSellToken(token, wallets, type = "", percent = 100) {
    const { ctx } = this;
    console.log(chalk.green("\n Pump fun batch sell Token----"));

    if (token && wallets) {
      const sellAll = String(type).toLowerCase() === "all";
      const getWalletSellPercent = (wallet) => {
        const walletPercent =
          sellAll
            ? 100
            : typeof wallet.sellRatio === "number"
            ? wallet.sellRatio * 100
            : percent;
        const normalizedPercent = Number(walletPercent);
        if (
          !Number.isFinite(normalizedPercent) ||
          normalizedPercent <= 0 ||
          normalizedPercent > 100
        ) {
          throw new Error(
            "sell percent must be greater than 0 and less than or equal to 100"
          );
        }
        return normalizedPercent;
      };

      const tokenMint = new PublicKey(token);
      const newWallets = [];
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const balance = await getSPLBalance(
          connection,
          tokenMint,
          keypair.publicKey
        );
        const sellPercent = getWalletSellPercent(wallet);
        const tokenAmount = (balance * sellPercent) / 100;

        console.log(
          `${user.toBase58()} sell ${tokenAmount} (${sellPercent}%) ${token}`
        );
        if ((sellAll ? balance > 0 : balance >= 100) && tokenAmount > 0) {
          newWallets.push({ ...wallet, tokenAmount });
        }
      }

      const func = async (bundleWallets) => {
        const { blockhash } = await connection.getLatestBlockhash();
        const jipAcc = ctx.service.jito.getTipAcc();
        const sellTxns = [];
        for (let i = 0; i < bundleWallets.length; i++) {
          const wallet = bundleWallets[i];
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const tokenAmount = wallet.tokenAmount;

          const { limit, price, fee } = wallet;
          const slippageBasisPoints = getWalletSlippageBasisPoints(wallet);

          let volumeIxs = [];
          const sellTx = await pfSwap.sell(
            user,
            tokenMint,
            BigInt(Math.trunc(tokenAmount * Math.pow(10, 6))),
            slippageBasisPoints,
            {
              unitLimit: limit,
              unitPrice: price,
            },
            "processed",
          );
          const jitoTipIx = SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: jipAcc,
            lamports: fee * LAMPORTS_PER_SOL,
          });
          volumeIxs = [...sellTx.instructions, jitoTipIx];

          try {
            const messageV0 = new TransactionMessage({
              payerKey: keypair.publicKey,
              recentBlockhash: blockhash,
              instructions: volumeIxs,
            }).compileToV0Message();

            const tx = new VersionedTransaction(messageV0);
            tx.sign([keypair]);
            await simulatePumpFunTransaction(tx, user, ctx);
            sellTxns.push(tx);
          } catch (error) {
            console.error(
              chalk.red(
                `Error compiling transaction for ${user.toBase58()}:`,
                error.message,
              ),
            );
            continue;
          }
        }

        console.log("sellTxns", sellTxns.length);
        if (sellTxns.length > 0) {
          if (sellTxns.length === 1) {
            const transferTx = sellTxns[0];
            const signature = await connection.sendTransaction(transferTx, {
              skipPreflight: !isDevelopmentEnvironment(ctx),
            });
            await connection.confirmTransaction(signature, "processed");
            return true;
          }
          const bundleResult = await ctx.service.jito.sendBundle(sellTxns);
          console.log(bundleResult);

          console.log(chalk.green("Sell transactions completed."));
        }
        return true;
      };

      const bundles = splitIntoBundles(newWallets);
      for (const bundleWallets of bundles) {
        await func(bundleWallets);
      }
      return true;
    } else {
      throw new Error("batch sell Token: param error");
    }
  }

  async getPoolDetail(token) {
    const { ctx } = this;

    const res = await pfSwap.getBondingCurveAccount(new PublicKey(token));
    return { dev: res.creator.toBase58() };
  }
}
module.exports = PumpFun;
