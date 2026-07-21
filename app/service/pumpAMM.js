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
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createInitializeAccountInstruction,
} = require("@solana/spl-token");

const bs58 = require("bs58");
const chalk = require("chalk");

const { getPoolsWithPrices } = require("../libs/pool");

const {
  connection,
  WSOL_TOKEN_ACCOUNT,
  BLOCK_RAZOR_1,
} = require("../constants");
const PumpSwapSDK = require("../libs/pumpSwap");
const AvePumpSwapSDK = require("../libs/aveProxy");
const OKXSwapSDK = require("../libs/okxRouterV2");
const JupSDK = require("../libs/jup");
const { createAxiomBuyInstructions } = require("../libs/axiom");
const {
  getSPLBalance,
  sendV0Transaction,
  getTokenProgramId,
} = require("../utils/solana");
const { createTroProxyInstruction } = require("../libs/trogan");
const moment = require("moment");
const { sleep } = require("../utils/utils");
const { getRandomAccount } = require("../utils/slot0trade");

const NEXTBLOCK_TIP_EVERY_TX = process.env.NEXTBLOCK_TIP_EVERY_TX === "true";
const SIMULATE_BEFORE_BUNDLE = process.env.SIMULATE_BEFORE_BUNDLE === "true";

const RENT_SYSVAR = new PublicKey(
  "SysvarRent111111111111111111111111111111111",
);

const GMGN_FEES_VAULT = new PublicKey(
  "DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9",
);
const GMGN_FEE_LAMPORTS = 10_000;

const TROGAN_FEE = 0.00036;

const TRANSACTION_FEE = 5000;
const MAX_TRANSACTION_SIZE = 1232;
const DEFAULT_PROXY_PUMP_SWAP_LOOKUP_TABLE =
  "4j834PBihsChsKWF4SZCY4K9tVNHc5JFpw1vEDJgbW29";
const AXIOM_COMPUTE_BUDGET_MARKER = new PublicKey(
  process.env.AXIOM_COMPUTE_BUDGET_MARKER ||
    "jitodontfront81111111TradeWithAxiomDotTrade",
);
const AXIOM_COMPUTE_UNIT_LIMIT = Number(
  process.env.AXIOM_COMPUTE_UNIT_LIMIT || 275000,
);
const AVE_COMPUTE_UNIT_LIMIT = Number(
  process.env.AVE_COMPUTE_UNIT_LIMIT || 500000,
);
const AXIOM_MEV_TIP_ACCOUNT = new PublicKey(
  process.env.AXIOM_MEV_TIP_ACCOUNT ||
    "DKbvWuh6NeDTAbeZ8stnMkobcZM4umbXmeAHXSzKXfsi",
);
const AXIOM_MEV_TIP_LAMPORTS = Number(process.env.AXIOM_MEV_TIP_LAMPORTS || 0);
// When true, drop the jitodontfront marker so Axiom txns can go through a Jito
// bundle (co-land atomically) at the cost of losing anti-frontrun protection.
// When false (default), keep the marker for anti-frontrun protection and concurrent RPC sends.
const AXIOM_BUNDLE_MODE = process.env.AXIOM_BUNDLE_MODE === "true";

const SLIPPAGE_BASIS_POINTS = 0.3;

const pSwap = new PumpSwapSDK();
const avePumpSwap = new AvePumpSwapSDK();
// const pSwap = new PumpAmmSdk(connection);

const okxSwap = new OKXSwapSDK();
const jupSwap = new JupSDK();

class PumpAMM extends Service {
  constructor(ctx) {
    super(ctx);
    this.subscriptionId = null;
    this.pumpSwapLookupTables = null;
  }

  getLookupTableAddresses() {
    const configuredAddresses = [
      process.env.PROXY_PUMP_SWAP_LOOKUP_TABLE ||
        DEFAULT_PROXY_PUMP_SWAP_LOOKUP_TABLE,
      process.env.PUMP_AMM_LOOKUP_TABLES,
      process.env.AXIOM_LOOKUP_TABLES,
    ]
      .flatMap((value) => (value || "").split(","))
      .map((value) => value.trim())
      .filter(Boolean);

    return [...new Set(configuredAddresses)];
  }

  async getProxyPumpSwapLookupTables() {
    if (this.pumpSwapLookupTables) {
      return this.pumpSwapLookupTables;
    }

    const lookupTableAddresses = this.getLookupTableAddresses();
    this.pumpSwapLookupTables = [];

    for (const lookupTableAddress of lookupTableAddresses) {
      try {
        const lookupTable = await connection.getAddressLookupTable(
          new PublicKey(lookupTableAddress),
        );
        if (lookupTable.value) {
          this.pumpSwapLookupTables.push(lookupTable.value);
        } else {
          console.log(
            chalk.yellow(
              `Pump AMM lookup table not found: ${lookupTableAddress}`,
            ),
          );
        }
      } catch (error) {
        console.log(
          chalk.yellow(
            `Failed to load pump AMM lookup table ${lookupTableAddress}: ${error.message}`,
          ),
        );
      }
    }

    return this.pumpSwapLookupTables;
  }

  /**
   * buy token  bundle
   * @param {*} token
   * @param {*} wallets [{keypair: keypair, amount: 0.1}]
   */
  async batchBuyToken(token, wallets, type = "", sendOptions = {}) {
    const { ctx } = this;
    console.log(chalk.green("\npump amm batchBuyToken----", wallets.length));

    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      const { blockhash } = await connection.getLatestBlockhash();

      const tokenProgramId = await getTokenProgramId(tokenMint);
      const poolDetail = await getPoolsWithPrices(tokenMint, ctx);
      const func = async (wallets) => {
        const buyTxns = [];
        const jipAcc = ctx.service.jito.getTipAcc();
        const tipAmount = ctx.service.jito.getTipAmount();
        const lookupTableAccounts = await this.getProxyPumpSwapLookupTables();
        const lookupTables = lookupTableAccounts.length
          ? lookupTableAccounts
          : undefined;
        let bundleHasTip = false;
        for (let i = 0; i < wallets.length; i++) {
          const slippage = i === 0 ? 0.1 : SLIPPAGE_BASIS_POINTS;
          const wallet = wallets[i];
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const { buyAmount, limit, price, fee, isAxiom, isAve } = wallet;
          let volumeIxs = [];
          let jitoTipIx = null;
          console.log(`${user.toBase58()} buy ${buyAmount} ${token}`);
          if (wallet.isOkx) {
            const okxIxs = await okxSwap.getBuyInstructions(ctx, {
              user,
              tokenMint,
              buyAmount: buyAmount,
              slippage,
              poolDetail,
            });
            volumeIxs = [...okxIxs];
          } else if (wallet.isJup) {
            const jupIxs = await jupSwap.getBuyInstructions(ctx, {
              user,
              tokenMint,
              buyAmount: buyAmount,
              slippage,
            });
            volumeIxs = [...jupIxs];
          } else {
            const setComputeUnitLimitIx =
              ComputeBudgetProgram.setComputeUnitLimit({
                units: isAxiom
                  ? AXIOM_COMPUTE_UNIT_LIMIT
                  : isAve
                    ? AVE_COMPUTE_UNIT_LIMIT
                    : limit,
              });
            if (isAxiom && !AXIOM_BUNDLE_MODE) {
              setComputeUnitLimitIx.keys.push({
                pubkey: AXIOM_COMPUTE_BUDGET_MARKER,
                isSigner: false,
                isWritable: false,
              });
            }

            const setComputeUnitPriceIx =
              ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: price,
              });

            const proxyBuyIxs = await this.genBuyProxyIxs({
              tokenMint,
              wallet,
              poolDetail,
              slippage,
              isAxiom,
              tokenProgramId,
            });
            volumeIxs = [
              setComputeUnitLimitIx,
              setComputeUnitPriceIx,
              ...proxyBuyIxs,
            ];
            if (isAxiom && AXIOM_MEV_TIP_LAMPORTS > 0) {
              volumeIxs.push(
                SystemProgram.transfer({
                  fromPubkey: user,
                  toPubkey: AXIOM_MEV_TIP_ACCOUNT,
                  lamports: AXIOM_MEV_TIP_LAMPORTS,
                }),
              );
            }

            // 9, gmgn, trogan, jito
            if (wallet.isGmgn) {
              const gmgnTipTx = SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: GMGN_FEES_VAULT,
                lamports: GMGN_FEE_LAMPORTS,
              });
              volumeIxs.push(gmgnTipTx);
            }
            if (wallet.isTrogan) {
              const troganTipIx = createTroProxyInstruction(user, jipAcc);

              if (troganTipIx) {
                volumeIxs.push(troganTipIx);
              }
            }

            if (wallets.length > 1 && (NEXTBLOCK_TIP_EVERY_TX || i === 0)) {
              jitoTipIx = SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: jipAcc,
                lamports: tipAmount,
              });
              volumeIxs.push(jitoTipIx);
            }

            if (
              wallets.length > 1 &&
              !jitoTipIx &&
              (NEXTBLOCK_TIP_EVERY_TX || !bundleHasTip)
            ) {
              jitoTipIx = SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: jipAcc,
                lamports: tipAmount,
              });
              volumeIxs.push(jitoTipIx);
            }
          }
          try {
            let tx;
            let splitTipTx = null;
            const assertTxSize = (transaction, label) => {
              const size = transaction.serialize().length;
              if (size > MAX_TRANSACTION_SIZE) {
                throw new Error(
                  `${label} size ${size} exceeds maximum allowed size of ${MAX_TRANSACTION_SIZE} bytes`,
                );
              }
              return size;
            };
            try {
              const messageV0 = new TransactionMessage({
                payerKey: user,
                recentBlockhash: blockhash,
                instructions: volumeIxs,
              }).compileToV0Message(lookupTables);

              tx = new VersionedTransaction(messageV0);
              tx.sign([keypair, ...(wallet.extraSigners || [])]);
              assertTxSize(tx, "swap tx");
            } catch (error) {
              const canSplitTip =
                jitoTipIx &&
                /(encoding overruns Uint8Array|exceeds maximum allowed size)/.test(
                  error.message,
                );
              if (!canSplitTip) {
                if (
                  wallet.isAxiom &&
                  /encoding overruns Uint8Array/.test(error.message)
                ) {
                  throw new Error(
                    "Axiom transaction is too large. Configure AXIOM_LOOKUP_TABLES with the Axiom address lookup table used by the source transaction.",
                  );
                }
                throw error;
              }

              let swapIxs = volumeIxs.filter((ix) => ix !== jitoTipIx);
              let swapMessageV0;
              try {
                swapMessageV0 = new TransactionMessage({
                  payerKey: user,
                  recentBlockhash: blockhash,
                  instructions: swapIxs,
                }).compileToV0Message(lookupTables);
              } catch (splitError) {
                if (!/encoding overruns Uint8Array/.test(splitError.message)) {
                  throw splitError;
                }

                swapIxs = swapIxs.filter(
                  (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
                );
                swapMessageV0 = new TransactionMessage({
                  payerKey: user,
                  recentBlockhash: blockhash,
                  instructions: swapIxs,
                }).compileToV0Message(lookupTables);
                console.log(
                  chalk.yellow(
                    "Removed compute budget instructions because swap tx is still too large.",
                  ),
                );
              }
              tx = new VersionedTransaction(swapMessageV0);
              tx.sign([keypair, ...(wallet.extraSigners || [])]);
              try {
                assertTxSize(tx, "swap tx");
              } catch (sizeError) {
                if (wallet.isAxiom) {
                  throw new Error(
                    "Axiom transaction is too large. Configure AXIOM_LOOKUP_TABLES with the Axiom address lookup table used by the source transaction.",
                  );
                }
                if (!/exceeds maximum allowed size/.test(sizeError.message)) {
                  throw sizeError;
                }

                swapIxs = swapIxs.filter(
                  (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
                );
                const compactMessageV0 = new TransactionMessage({
                  payerKey: user,
                  recentBlockhash: blockhash,
                  instructions: swapIxs,
                }).compileToV0Message(lookupTables);
                tx = new VersionedTransaction(compactMessageV0);
                tx.sign([keypair, ...(wallet.extraSigners || [])]);
                assertTxSize(tx, "compact swap tx");
                console.log(
                  chalk.yellow(
                    "Removed compute budget instructions because swap tx is still too large.",
                  ),
                );
              }

              const tipMessageV0 = new TransactionMessage({
                payerKey: user,
                recentBlockhash: blockhash,
                instructions: [jitoTipIx],
              }).compileToV0Message();
              splitTipTx = new VersionedTransaction(tipMessageV0);
              splitTipTx.sign([keypair]);
              assertTxSize(splitTipTx, "tip tx");
              console.log(
                chalk.yellow(
                  "Split Jito tip into a separate transaction because swap tx is too large.",
                ),
              );
            }

            // 模拟交易
            if (wallet.isAxiom) {
              console.log(
                "Axiom tx instructions",
                volumeIxs.map((ix, index) => ({
                  index,
                  programId: ix.programId.toBase58(),
                  data: Buffer.from(ix.data || []).toString("hex"),
                  accounts: ix.keys.map((key) => ({
                    pubkey: key.pubkey.toBase58(),
                    signer: key.isSigner,
                    writable: key.isWritable,
                  })),
                })),
              );
            }

            const simulationResult = await connection.simulateTransaction(tx, {
              commitment: "confirmed",
            });
            if (simulationResult.value.err) {
              console.error("simulation", simulationResult.value);
              throw new Error(
                `Simulation failed: ${JSON.stringify(simulationResult.value.err)} ${JSON.stringify(simulationResult.value.logs || [])}`,
              );
            }

            console.log(
              chalk.green("simulation success", keypair.publicKey.toString()),
            );
            buyTxns.push(tx);
            if (jitoTipIx) {
              bundleHasTip = true;
            }
            if (splitTipTx) {
              buyTxns.push(splitTipTx);
              bundleHasTip = true;
            }
          } catch (error) {
            console.error(error);
            break;
          }
        }

        // for end
        console.log("buyTxns", buyTxns.length);
        if (SIMULATE_BEFORE_BUNDLE) {
          for (let i = 0; i < buyTxns.length; i++) {
            const simulationResult = await connection.simulateTransaction(
              buyTxns[i],
              { commitment: "confirmed" },
            );
            if (simulationResult.value.err) {
              console.error("simulation tx", i, simulationResult.value);
              throw new Error(
                `Simulation failed for tx ${i}: ${JSON.stringify(simulationResult.value.err)}`,
              );
            }
            console.log(chalk.green("simulation success", i));
          }
        }
        // return;
        if (buyTxns.length > 1) {
          const bundleResult = await ctx.service.jito.sendBundle(
            buyTxns,
            sendOptions,
          );
          console.log(bundleResult);
          console.log(chalk.green("Buy transactions completed."));
        } else if (buyTxns.length === 1) {
          const bundleResult = await ctx.service.jito.sendTransaction(
            buyTxns[0],
            sendOptions,
          );
          console.log(bundleResult);
          console.log(chalk.green("Buy transactions completed."));
        }
      };

      if (type === "all") {
        let buyAllObj = {
          firstBuy: [],
          multiBuy: [],
          secondBuy: [],
          thirdBuy: [],
        };
        // 分离 firstWallet 和其他钱包
        const firstWallets = [];
        const regularWallets = [];

        wallets.forEach((wallet) => {
          if (wallet.isFirstWallet) {
            firstWallets.push(wallet);
          } else {
            regularWallets.push(wallet);
          }
        });

        regularWallets.forEach((wallet) => {
          if (wallet.firstBuy) {
            buyAllObj.firstBuy.push(wallet);
          } else if (wallet.secondBuy) {
            buyAllObj.secondBuy.push(wallet);
          } else if (wallet.multiBuy) {
            buyAllObj.multiBuy.push(wallet);
          } else if (wallet.thirdBuy) {
            buyAllObj.thirdBuy.push(wallet);
          }
        });

        // 执行普通钱包，各阶段之间无延迟
        for (const wallets of Object.values(buyAllObj)) {
          if (wallets.length > 0) {
            await func(wallets);
          }
        }

        // 如果有 firstWallet，等待 1 个 slot 后执行
        if (firstWallets.length > 0) {
          await sleep(0.4); // Solana slot 约 400ms，等待约 1 个区块
          for (const wallet of firstWallets) {
            await func([wallet]);
          }
        }

        return true;
      } else {
        return func(wallets);
      }
    } else {
      throw new Error("batchBuyToken: param error");
    }
  }

  async batchSellToken(token, wallets, type = "") {
    const { ctx } = this;
    console.log(chalk.green("\n batch sell Token----"));

    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      const tokenProgramId = await getTokenProgramId(tokenMint);

      const newWallets = [];
      const seenSellWallets = new Set();
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const tokenAmount = await getSPLBalance(
          connection,
          tokenMint,
          keypair.publicKey,
          tokenProgramId,
        );

        console.log(`${user.toBase58()} sell ${tokenAmount} ${token}`);
        if (tokenAmount >= 100) {
          const walletAddress = user.toBase58();
          if (seenSellWallets.has(walletAddress)) {
            console.log(
              chalk.yellow(`Skip duplicate sell wallet ${walletAddress}`),
            );
            continue;
          }
          seenSellWallets.add(walletAddress);
          newWallets.push({ ...wallet, tokenAmount });
        }
      }

      newWallets.reverse();

      const { blockhash } = await connection.getLatestBlockhash();
      const func = async (wallets) => {
        const poolDetail = await getPoolsWithPrices(tokenMint, ctx);
        const sellTxns = [];
        const jipAcc = ctx.service.jito.getTipAcc();
        const tipAmount = ctx.service.jito.getTipAmount();
        let bundleHasTip = false;
        for (let i = 0; i < wallets.length; i++) {
          const wallet = wallets[i];
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const tokenAmount = wallet.tokenAmount;

          const { limit, price, fee } = wallet;

          let volumeIxs = [];
          let jitoTipIx = null;

          // 1, setComputeUnitLimitIx
          const setComputeUnitLimitIx =
            ComputeBudgetProgram.setComputeUnitLimit({
              units: limit,
            });

          // 2,
          const setComputeUnitPriceIx =
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: price,
            });

          // 3, createAccountWithSeed
          const seed = new Date().getTime().toString();
          // const seed = "1749356034021";

          const newAccount = await PublicKey.createWithSeed(
            user,
            seed,
            TOKEN_PROGRAM_ID,
          );
          const createAccountWithSeedIx = SystemProgram.createAccountWithSeed({
            fromPubkey: user,
            newAccountPubkey: newAccount,
            basePubkey: user,
            seed: seed,
            lamports: 2039280,
            space: 165,
            programId: TOKEN_PROGRAM_ID,
          });

          // 4, initializeAccount
          const initializeAccountIx = createInitializeAccountInstruction(
            newAccount,
            WSOL_TOKEN_ACCOUNT,
            user,
            TOKEN_PROGRAM_ID,
          );

          // 5, pump sell
          const swapTx = await pSwap.createSellInstruction({
            user,
            tokenMint,
            tokenAmount,
            sellNewAccount: newAccount,
            poolDetail: poolDetail,
            tokenProgramId,
          });

          // 6. Token Program: closeAccount
          const closeAccountIx = createCloseAccountInstruction(
            newAccount,
            user,
            user,
          );

          volumeIxs = [
            setComputeUnitLimitIx,
            setComputeUnitPriceIx,
            createAccountWithSeedIx,
            initializeAccountIx,
            swapTx,
            closeAccountIx,
          ];
          if (wallets.length > 1 && i === 0) {
            jitoTipIx = SystemProgram.transfer({
              fromPubkey: keypair.publicKey,
              toPubkey: jipAcc,
              lamports: tipAmount,
            });
            volumeIxs.push(jitoTipIx);
          }

          try {
            const buildSellTx = (instructions) => {
              const messageV0 = new TransactionMessage({
                payerKey: keypair.publicKey,
                recentBlockhash: blockhash,
                instructions,
              }).compileToV0Message();

              const transaction = new VersionedTransaction(messageV0);
              transaction.sign([keypair]);
              return transaction;
            };

            let tx = buildSellTx(volumeIxs);
            if (tx.serialize().length > MAX_TRANSACTION_SIZE) {
              const compactIxs = volumeIxs.filter(
                (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
              );
              tx = buildSellTx(compactIxs);
              console.log(
                chalk.yellow(
                  "Removed compute budget instructions because sell tx is too large.",
                ),
              );
            }
            const txSize = tx.serialize().length;
            if (txSize > MAX_TRANSACTION_SIZE) {
              throw new Error(
                `sell tx size ${txSize} exceeds maximum allowed size of ${MAX_TRANSACTION_SIZE} bytes`,
              );
            }

            // 模拟交易
            // const simulationResult = await connection.simulateTransaction(tx, {
            //   commitment: "confirmed",
            // });
            // if (simulationResult.value.err) {
            //   console.log("simulation", simulationResult.value);
            //   throw new Error(simulationResult.value);
            // }

            // console.log(
            //   chalk.green("simulation success", keypair.publicKey.toString())
            // );
            sellTxns.push(tx);
            if (jitoTipIx) {
              bundleHasTip = true;
            }
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
        if (sellTxns.length > 1) {
          const bundleResult = await ctx.service.jito.sendBundle(sellTxns);
          console.log(bundleResult);
          console.log(chalk.green("Sell transactions completed."));
        } else if (sellTxns.length === 1) {
          const signatures = await ctx.service.jito.sendTransactionsByRpc([
            sellTxns[0],
          ]);
          console.log(signatures);
          console.log(chalk.green("Sell transaction completed."));
        }
        return true;
      };
      if (type === "all") {
        let sellAllObj = {
          thirdBuy: [],
          secondBuy: [],
          multiBuy: [],
          firstBuy: [],
          otherBuy: [],
        };
        newWallets.forEach((wallet) => {
          if (wallet.firstBuy) {
            sellAllObj.firstBuy.push(wallet);
          } else if (wallet.secondBuy) {
            sellAllObj.secondBuy.push(wallet);
          } else if (wallet.multiBuy) {
            sellAllObj.multiBuy.push(wallet);
          } else if (wallet.thirdBuy) {
            sellAllObj.thirdBuy.push(wallet);
          } else {
            sellAllObj.otherBuy.push(wallet);
          }
        });

        for (const wallets of Object.values(sellAllObj)) {
          if (wallets.length > 0) {
            await func(wallets);
            await sleep(0.5);
          }
        }
        return true;
      } else {
        return func(newWallets);
      }
    } else {
      throw new Error("batch sell Token: param error");
    }
  }

  async getBuyAmmIxs({
    tokenMint,
    user,
    buyAmount,
    poolDetail,
    slippage,
    isAxiom,
    tokenProgramId,
  }) {
    // 1
    const wSolATA = getAssociatedTokenAddressSync(
      WSOL_TOKEN_ACCOUNT,
      user,
      false,
    );
    //2
    const tokenAta = getAssociatedTokenAddressSync(
      tokenMint,
      user,
      false,
      tokenProgramId,
    );

    //3
    const createWSOLAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      user,
      wSolATA,
      user,
      WSOL_TOKEN_ACCOUNT,
    );

    // 指令 4: 创建 tokenA ATA
    const createTokenAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      user,
      tokenAta,
      user,
      tokenMint,
      tokenProgramId || TOKEN_PROGRAM_ID,
    );
    // 指令 5: 转账 SOL 到 wSOL ATA
    const transferLamportsWSOLIx = SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: wSolATA,
      lamports: Math.trunc(buyAmount * LAMPORTS_PER_SOL),
      // lamports:
      //   Math.trunc(buyAmount * LAMPORTS_PER_SOL) +
      //   ATA_RENT * 2 +
      //   TRANSACTION_FEE,
    });
    // 指令 6: 同步 wSOL ATA
    const syncNativeIx = createSyncNativeInstruction(wSolATA, TOKEN_PROGRAM_ID);

    // 指令 7: Pump AMM buy_exact_quote_in
    let swapIxs = await pSwap.createBuyExactQuoteInInstruction({
      tokenMint: tokenMint,
      user: user,
      buyAmount: buyAmount,
      slippage: slippage,
      poolDetail: poolDetail,
      tokenProgramId,
      isAxiom,
    });

    // 指令 8: 关闭 wSOL ATA
    const closeWSOLAtaIx = createCloseAccountInstruction(wSolATA, user, user);

    const Ixs = [
      createWSOLAtaIx,
      createTokenAtaIx,
      transferLamportsWSOLIx,
      syncNativeIx,
      swapIxs,
      closeWSOLAtaIx,
    ];
    return Ixs;
  }

  async genBuyProxyIxs({
    tokenMint,
    wallet,
    poolDetail,
    slippage,
    isAxiom,
    tokenProgramId,
  }) {
    const { ctx } = this;

    let proxyBuyIxs = [];

    const keypair = wallet.keypair;
    const user = keypair.publicKey;
    console.log(chalk.green("Build buy:", user.toBase58()));
    const { buyAmount } = wallet;
    if (isAxiom) {
      const axiomBuy = await createAxiomBuyInstructions({
        tokenMint,
        user,
        buyAmount,
        slippage,
        poolDetail,
        tokenProgramId,
        feeLamports: wallet.axiomFeeLamports,
      });
      wallet.extraSigners = axiomBuy.signers;
      proxyBuyIxs = axiomBuy.instructions;
    } else if (wallet.isAve) {
      console.log(chalk.green("AVE buy:", user.toBase58()));
      const proxyBuyIx = await avePumpSwap.createBuyInstruction({
        tokenMint: tokenMint,
        user: user,
        buyAmount: buyAmount,
        slippage: slippage,
        poolDetail: poolDetail,
        tokenProgramId,
        aveFeeBps: wallet.aveFeeBps,
      });
      proxyBuyIxs = [proxyBuyIx];
    } else {
      proxyBuyIxs = await this.getBuyAmmIxs({
        tokenMint,
        user,
        buyAmount,
        poolDetail,
        slippage,
        isAxiom,
        tokenProgramId,
      });
    }

    return proxyBuyIxs;
  }
}

module.exports = PumpAMM;
