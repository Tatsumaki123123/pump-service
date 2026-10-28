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

const {
  getPoolsWithPrices,
  getUserVolumeAccumulatorPda,
} = require("../libs/pool");

const {
  connection,
  WSOL_TOKEN_ACCOUNT,
  BLOCK_RAZOR_1,
  FOMO_RECEIVE_ADDRESS,
  FOMO_TRANSFER_LAMPORTS,
} = require("../constants");
const PumpSwapSDK = require("../libs/pumpSwap");
const {
  createProxyBuyInstruction,
  getProxyBuyInstruction,
  setProxyBuyMinBaseAmountOut,
} = require("../libs/pumpProxy");
const AvePumpSwapSDK = require("../libs/aveProxy");
const OKXSwapSDK = require("../libs/okxRouterV2");
const { setLocalOkxAmmExpectedAmountOut } = require("../libs/okxLocalRouter");
const JupSDK = require("../libs/jup");
const { getJupiterSellInstructions } = require("../libs/jupiterSellFallback");
const DFlowSDK = require("../libs/dflow");
const { createAxiomBuyInstructions } = require("../libs/axiom");
const {
  getSPLBalance,
  sendV0Transaction,
  getTokenProgramId,
} = require("../utils/solana");
const { createTroProxyInstruction } = require("../libs/trogan");
const {
  PADRE_FEE_RECIPIENT,
  PADRE_FEE_BASIS_POINTS,
  createPadreRouteInstruction,
  createPadrePumpAmmHopKeys,
  createPadreNonceInstructions,
  getPadreNonceAccount,
  getPadreSwapAccounts,
  getPadreBuyBaseAmountOut,
  isPadreRouteInstruction,
  setPadreRouteMinFinalOut,
} = require("../libs/padre");
const moment = require("moment");
const { sleep, splitIntoBundles } = require("../utils/utils");
const { getRandomAccount } = require("../utils/slot0trade");

// Avoid submitting dust balances that Pump AMM cannot sell successfully.
const MIN_SELL_TOKEN_AMOUNT_RAW = 100n;

const SIMULATE_BEFORE_BUNDLE = process.env.SIMULATE_BEFORE_BUNDLE === "true";

function isDevelopmentEnvironment(ctx) {
  const env = String(
    ctx?.app?.config?.env || process.env.NODE_ENV || "",
  ).toLowerCase();
  return env === "local" || env === "dev" || env === "development";
}

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
const DEFAULT_OKX_LOOKUP_TABLE =
  "GP57a1T8vJjeAnF2zfKT1bnZysNwVprLaw6Mjw2d1gPy";
const DEFAULT_AXIOM_LOOKUP_TABLE =
  "4vX5U9XsiY11infmC13d6VFPjvUqtuRw744r4o94dyow";
const AXIOM_COMPUTE_BUDGET_MARKER = new PublicKey(
  process.env.AXIOM_COMPUTE_BUDGET_MARKER ||
    "jitodontfront61111111TradeWithAxiomDotTrade",
);
const AXIOM_COMPUTE_UNIT_LIMIT = Number(
  process.env.AXIOM_COMPUTE_UNIT_LIMIT || 275000,
);
const AXIOM_COMPUTE_UNIT_PRICE = Number(
  process.env.AXIOM_COMPUTE_UNIT_PRICE || 218916,
);
const BUNDLE_PROVIDER = (
  process.env.BUNDLE_PROVIDER || "quicknode"
).toLowerCase();
const PUMP_AMM_DONT_FRONT = process.env.PUMP_AMM_DONT_FRONT !== "false";
const PUMP_AMM_DONT_FRONT_PROVIDERS = new Set(["jito"]);
const PUMP_AMM_DONT_FRONT_MARKER = new PublicKey(
  process.env.PUMP_AMM_DONT_FRONT_MARKER ||
    "jitodontfront81111111TradeWithAxiomDotTrade",
);
const PADRE_DONT_FRONT_MARKER = new PublicKey(
  "jitodontfront11111111111TradeWithPadreDotGg",
);
const AVE_COMPUTE_UNIT_LIMIT = Number(
  process.env.AVE_COMPUTE_UNIT_LIMIT || 500000,
);
// DFlow/Jupiter slippage is passed as a fraction: 0.05 = 5%.
const SLIPPAGE_BASIS_POINTS = Number(
  process.env.DFLOW_BATCH_SLIPPAGE || 0.05,
);
const BUY_SLIPPAGE_ERROR = "BuySlippageBelowMinBaseAmountOut";
const BASIS_POINTS_DENOMINATOR = 10000n;

function usesDedicatedPumpRoute(wallet) {
  return wallet.isAxiom || wallet.isPadre || wallet.isAve ||
    wallet.isProxy || wallet.isOkx || wallet.isDflow ||
    wallet.isGmgn || wallet.isFomo || wallet.isTrogan ||
    wallet.isTragon;
}

function requiresPumpPool(wallet) {
  return usesDedicatedPumpRoute(wallet) && !wallet.isDflow;
}

function getChainBuyBaseAmountOut(logs) {
  if (
    !Array.isArray(logs) ||
    !logs.some((log) => log.includes(BUY_SLIPPAGE_ERROR))
  ) {
    return null;
  }

  for (let i = logs.length - 1; i >= 0; i--) {
    const match = logs[i].match(/Program log: Left:\s*(\d+)/);
    if (match) {
      return BigInt(match[1]);
    }
  }

  return null;
}

function getOkxAmmAmountOut(logs) {
  for (let i = (logs || []).length - 1; i >= 0; i--) {
    const match = logs[i].match(
      /Program log: SwapEvent \{ dex: PumpfunammBuy2, .*amount_out:\s*(\d+)/,
    ) || logs[i].match(/Program log: final_out:\s*(\d+)/);
    if (match) return BigInt(match[1]);
  }
  return null;
}

function getMinBaseAmountOut(baseAmountOut, slippage) {
  const normalizedSlippage = Number(slippage);
  if (
    !Number.isFinite(normalizedSlippage) ||
    normalizedSlippage < 0 ||
    normalizedSlippage > 1
  ) {
    throw new Error("slippage must be between 0 and 1");
  }

  const slippageBps = BigInt(Math.floor(normalizedSlippage * 10000));
  return {
    slippageBps,
    minBaseAmountOut:
      (baseAmountOut * (BASIS_POINTS_DENOMINATOR - slippageBps)) /
      BASIS_POINTS_DENOMINATOR,
  };
}

function mergeLookupTableAccounts(...lookupTableGroups) {
  const lookupTableMap = new Map();
  lookupTableGroups
    .flat()
    .filter(Boolean)
    .forEach((lookupTable) => {
      lookupTableMap.set(lookupTable.key.toBase58(), lookupTable);
    });
  const lookupTables = [...lookupTableMap.values()];
  return lookupTables.length ? lookupTables : undefined;
}

const pSwap = new PumpSwapSDK();
const avePumpSwap = new AvePumpSwapSDK();
// const pSwap = new PumpAmmSdk(connection);

const okxSwap = new OKXSwapSDK();
const jupSwap = new JupSDK();
const dflowSwap = new DFlowSDK();

class PumpAMM extends Service {
  constructor(ctx) {
    super(ctx);
    this.subscriptionId = null;
    this.lookupTablesByRoute = new Map();
  }

  getLookupTableAddresses(isAxiom = false, isOkx = false) {
    const configuredAddresses = isAxiom
      ? [process.env.AXIOM_LOOKUP_TABLES || DEFAULT_AXIOM_LOOKUP_TABLE]
      : [
          process.env.PROXY_PUMP_SWAP_LOOKUP_TABLE ||
            DEFAULT_PROXY_PUMP_SWAP_LOOKUP_TABLE,
          process.env.PUMP_AMM_LOOKUP_TABLES,
          ...(isOkx
            ? [
                process.env.OKX_LOOKUP_TABLES || DEFAULT_OKX_LOOKUP_TABLE,
              ]
            : []),
        ];

    return configuredAddresses
      .flatMap((value) => (value || "").split(","))
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async getProxyPumpSwapLookupTables(isAxiom = false, isOkx = false) {
    const route = isAxiom ? "axiom" : isOkx ? "okxPumpAmm" : "pumpAmm";
    if (this.lookupTablesByRoute.has(route)) {
      return this.lookupTablesByRoute.get(route);
    }

    const lookupTableAddresses = this.getLookupTableAddresses(isAxiom, isOkx);
    const lookupTables = [];
    this.lookupTablesByRoute.set(route, lookupTables);

    for (const lookupTableAddress of lookupTableAddresses) {
      try {
        const lookupTable = await connection.getAddressLookupTable(
          new PublicKey(lookupTableAddress),
        );
        if (lookupTable.value) {
          lookupTables.push(lookupTable.value);
        } else {
          console.log(
            chalk.yellow(
              `${isAxiom ? "Axiom" : "Pump AMM"} lookup table not found: ${lookupTableAddress}`,
            ),
          );
        }
      } catch (error) {
        console.log(
          chalk.yellow(
            `Failed to load ${isAxiom ? "Axiom" : "Pump AMM"} lookup table ${lookupTableAddress}: ${error.message}`,
          ),
        );
      }
    }

    return lookupTables;
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
      const needsPoolDetail = wallets.some(
        (wallet) => requiresPumpPool(wallet) ||
          (!wallet.isDflow && !wallet.isJup),
      );
      let poolDetail;
      let useJupFallback = false;
      if (needsPoolDetail) {
        try {
          poolDetail = await getPoolsWithPrices(tokenMint, ctx);
        } catch (error) {
          if (error.code !== "NO_WSOL_PUMP_POOL") throw error;
          useJupFallback = true;
          console.log(
            chalk.yellow(
              `No WSOL Pump AMM pool for ${tokenMint.toBase58()}; routing ordinary wallets through Jupiter.`,
            ),
          );
        }
      }
      if (useJupFallback && wallets.some(requiresPumpPool)) {
        if (wallets.some((wallet) => wallet.isAxiom)) {
          throw new Error(
            `Axiom multi-hop buy for non-WSOL Pump AMM pool ${tokenMint.toBase58()} is not implemented; the current Axiom instruction builder only supports WSOL quote pools`,
          );
        }
        throw new Error(
          `No WSOL Pump AMM pool for ${tokenMint.toBase58()}; configured dedicated-route wallets require their Pump route`,
        );
      }
      const func = async (wallets) => {
        const isNozomi =
          String(sendOptions.batchPlatform || "").toLowerCase() === "nozomi";
        const limitedBundleProvider =
          !isNozomi &&
          ["quicknode", "jito", "helius", "helius_jito"].includes(
            BUNDLE_PROVIDER,
          );
        if (limitedBundleProvider && wallets.length > 5) {
          await Promise.all(
            splitIntoBundles(wallets, 5).map((group) => func(group)),
          );
          return;
        }
        const buyTxns = [];
        const isPadreBundle = wallets.length > 1 &&
          wallets.every((wallet) => wallet.isPadre && !wallet.isProxy);
        const isAxiomBuyWallet = (wallet) =>
          !wallet.isProxy && !wallet.isPadre && wallet.isAxiom;
        const firstOrdinaryWalletIndex = wallets.findIndex(
          (wallet) => !isAxiomBuyWallet(wallet),
        );
        const combineAxiomBuys =
          !isNozomi &&
          wallets.length <= 5 &&
          isAxiomBuyWallet(wallets[0]) &&
          (firstOrdinaryWalletIndex === -1 ||
            !wallets.slice(firstOrdinaryWalletIndex).some(isAxiomBuyWallet));
        const lastOrdinaryWalletIndex = wallets.reduce(
          (lastIndex, wallet, index) =>
            isAxiomBuyWallet(wallet) ? lastIndex : index,
          -1,
        );
        let jipAcc = ctx.service.jito.getTipAcc(sendOptions);
        const tipAmount = ctx.service.jito.getTipAmount(sendOptions);
        let bundleHasAxiomDontFront = false;
        const dflowBuyData = await Promise.all(
          wallets.map((wallet, i) => {
            if (!wallet.isDflow || wallet.isPadre || wallet.isProxy ||
                wallet.isAxiom || wallet.isAve || wallet.isOkx) {
              return null;
            }
            const slippage = wallet.slippage ?? SLIPPAGE_BASIS_POINTS;
            const { buyAmount, price } = wallet;
            return dflowSwap.getBuyInstructions(ctx, {
              user: wallet.keypair.publicKey,
              tokenMint,
              buyAmount,
              slippage,
              connection,
              price,
            });
          }),
        );
        for (let i = 0; i < wallets.length; i++) {
          if (isNozomi) {
            jipAcc = ctx.service.jito.getTipAcc(sendOptions);
          }
          const wallet = wallets[i];
          const slippage = wallet.slippage ?? SLIPPAGE_BASIS_POINTS;
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const { buyAmount, limit, price, fee } = wallet;
          const isProxy = wallet.isProxy === true;
          const isAxiom = !isProxy && !wallet.isPadre && wallet.isAxiom;
          const isAve = !isProxy && !wallet.isPadre && wallet.isAve;
          let lookupTableAccounts =
            await this.getProxyPumpSwapLookupTables(
              isAxiom && !wallet.isOkx,
              wallet.isOkx && !wallet.isPadre && !isProxy,
            );
          const lookupTables = lookupTableAccounts.length
            ? lookupTableAccounts
            : undefined;
          let volumeIxs = [];
          let jitoTipIx = null;
          let troganTipIx = null;
          let walletLookupTables = lookupTables;
          if (wallet.isOkx && !wallet.isPadre && !isProxy) {
            const okxIxs = await okxSwap.getLocalBuyInstructions(ctx, {
              user,
              tokenMint,
              buyAmount: buyAmount,
              slippage,
              tokenProgramId,
              route: "pumpAmm",
              poolDetail,
            });
            volumeIxs = [
              ...(limit
                ? [
                    ComputeBudgetProgram.setComputeUnitLimit({
                      units: limit,
                    }),
                  ]
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
            if (
              !isAxiom &&
              !isNozomi &&
              i ===
                (combineAxiomBuys
                  ? wallets.length - 1
                  : lastOrdinaryWalletIndex)
            ) {
              jitoTipIx = SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: jipAcc,
                lamports: tipAmount,
              });
              volumeIxs.push(jitoTipIx);
            }
          } else if (wallet.isDflow && !wallet.isPadre && !isProxy &&
                     !wallet.isAxiom && !wallet.isAve && !wallet.isOkx) {
            const dflowSwapData = dflowBuyData[i];
            volumeIxs = [...dflowSwapData.instructions];
            lookupTableAccounts = dflowSwapData.lookupTableAccounts;
            walletLookupTables = mergeLookupTableAccounts(
              lookupTables,
              dflowSwapData.lookupTableAccounts,
            );
            if (
              !isAxiom &&
              !isNozomi &&
              i ===
                (combineAxiomBuys
                  ? wallets.length - 1
                  : lastOrdinaryWalletIndex)
            ) {
              jitoTipIx = SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: jipAcc,
                lamports: tipAmount,
              });
              volumeIxs.push(jitoTipIx);
            }
          } else if (
            (wallet.isJup || useJupFallback) &&
            !usesDedicatedPumpRoute(wallet)
          ) {
            const jupSwapData = await jupSwap.getBuyInstructions(ctx, {
              user,
              tokenMint,
              buyAmount,
              slippage: useJupFallback
                ? wallet.slippage ?? 0.01
                : slippage,
              connection,
            });
            volumeIxs = [...jupSwapData.instructions];
            walletLookupTables = mergeLookupTableAccounts(
              lookupTables,
              jupSwapData.lookupTableAccounts,
            );
            if (
              !isAxiom &&
              !isNozomi &&
              i ===
                (combineAxiomBuys
                  ? wallets.length - 1
                  : lastOrdinaryWalletIndex)
            ) {
              jitoTipIx = SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: jipAcc,
                lamports: tipAmount,
              });
              volumeIxs.push(jitoTipIx);
            }
          } else {
            const setComputeUnitLimitIx =
              ComputeBudgetProgram.setComputeUnitLimit({
                units: isAxiom
                  ? AXIOM_COMPUTE_UNIT_LIMIT
                  : isAve
                    ? AVE_COMPUTE_UNIT_LIMIT
                    : limit,
              });
            // A bundle may contain only one jitodontfront protected prefix
            // unless the protected transactions share a signer. Axiom buys
            // normally use different wallets, so mark only the first Axiom
            // transaction when Axiom and Pump AMM buys are sent together.
            const shouldAddAxiomDontFront =
              isAxiom && (!combineAxiomBuys || !bundleHasAxiomDontFront);
            const shouldAddPumpAmmDontFront =
              !isAxiom &&
              !isAve &&
              (!wallet.isPadre || isProxy) &&
              wallets.length === 1 &&
              PUMP_AMM_DONT_FRONT &&
              PUMP_AMM_DONT_FRONT_PROVIDERS.has(BUNDLE_PROVIDER);
            // Different Padre wallets have different signers. Only the first
            // bundle transaction may carry the Jito protection marker.
            if (
              shouldAddAxiomDontFront ||
              shouldAddPumpAmmDontFront ||
              (wallet.isPadre && !isProxy && i === 0)
            ) {
              setComputeUnitLimitIx.keys.push({
                pubkey: shouldAddAxiomDontFront
                  ? AXIOM_COMPUTE_BUDGET_MARKER
                  : wallet.isPadre && !isProxy
                    ? PADRE_DONT_FRONT_MARKER
                    : PUMP_AMM_DONT_FRONT_MARKER,
                isSigner: false,
                isWritable: false,
              });
              if (shouldAddAxiomDontFront) {
                bundleHasAxiomDontFront = true;
              }
            }

            const setComputeUnitPriceIx =
              ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: isAxiom
                  ? wallet.axiomComputeUnitPrice ?? AXIOM_COMPUTE_UNIT_PRICE
                  : price,
              });

            const proxyBuyIxs = wallet.isPadre && !isProxy
              ? await this.genPadreBuyIxs({
                  tokenMint,
                  wallet,
                  poolDetail,
                  slippage,
                  tokenProgramId,
                })
              : await this.genBuyProxyIxs({
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
            // 9, gmgn, trogan, jito
            if (wallet.isGmgn) {
              const gmgnTipTx = SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: GMGN_FEES_VAULT,
                lamports: GMGN_FEE_LAMPORTS,
              });
              volumeIxs.push(gmgnTipTx);
            }
            if (wallet.isFomo) {
              volumeIxs.push(
                SystemProgram.transfer({
                  fromPubkey: user,
                  toPubkey: FOMO_RECEIVE_ADDRESS,
                  lamports: FOMO_TRANSFER_LAMPORTS,
                }),
              );
            }
            const shouldAddJitoTip =
              !isAxiom &&
              !isNozomi &&
              i ===
                (combineAxiomBuys
                  ? wallets.length - 1
                  : lastOrdinaryWalletIndex);
            if (shouldAddJitoTip) {
              jitoTipIx = SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: jipAcc,
                lamports: tipAmount,
              });
              volumeIxs.push(jitoTipIx);
            }

          }
          // Keep the bundle tip on the final transaction. This leaves the
          // first Axiom transaction room for its jitodontfront marker.
          if (
            isAxiom &&
            !isNozomi &&
            (!combineAxiomBuys || i === wallets.length - 1)
          ) {
            jitoTipIx = SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: jipAcc,
              lamports: tipAmount,
            });
            volumeIxs.push(jitoTipIx);
          }
          if (isNozomi && i === wallets.length - 1) {
            jitoTipIx = SystemProgram.transfer({
              fromPubkey: user,
              toPubkey: jipAcc,
              lamports: tipAmount,
            });
            volumeIxs.push(jitoTipIx);
          }
          if (wallet.isTrogan || wallet.isTragon) {
            troganTipIx = createTroProxyInstruction(
              user,
              jipAcc,
              undefined,
              { includeJitoDontFront: i === 0 },
            );
            if (troganTipIx) {
              volumeIxs.push(troganTipIx);
            }
          }
          try {
            let tx;
            let splitTipTx = null;
            let txInstructions = volumeIxs;
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
              }).compileToV0Message(walletLookupTables);

              tx = new VersionedTransaction(messageV0);
              tx.sign([keypair, ...(wallet.extraSigners || [])]);
              assertTxSize(tx, "swap tx");
            } catch (error) {
              const canSplitTip =
                jitoTipIx &&
                /(encoding overruns Uint8Array|exceeds maximum allowed size)/.test(
                  error.message,
                );
              const compactAxiom =
                isAxiom &&
                /(encoding overruns Uint8Array|exceeds maximum allowed size)/.test(
                  error.message,
                );
              if (compactAxiom) {
                const compactIxs = volumeIxs.filter(
                  (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
                );
                const compactMessageV0 = new TransactionMessage({
                  payerKey: user,
                  recentBlockhash: blockhash,
                  instructions: compactIxs,
                }).compileToV0Message(walletLookupTables);
                tx = new VersionedTransaction(compactMessageV0);
                tx.sign([keypair, ...(wallet.extraSigners || [])]);
                assertTxSize(tx, "compact Axiom swap tx");
                txInstructions = compactIxs;
                console.log(
                  chalk.yellow(
                    "Removed compute budget instructions from the Axiom transaction because it was too large.",
                  ),
                );
              } else if (
                canSplitTip &&
                (isNozomi || isAxiom || (wallet.isPadre && !isProxy))
              ) {
                throw new Error(
                  `${isNozomi ? "Nozomi" : isAxiom ? "Axiom" : "Padre"} transaction is too large after adding the required bundle tip; reduce the swap instruction size or use a more compact lookup table.`,
                );
              }
              if (!compactAxiom && !canSplitTip) {
                if (
                  isAxiom &&
                  /encoding overruns Uint8Array/.test(error.message)
                ) {
                  throw new Error(
                    "Axiom transaction is too large. Configure AXIOM_LOOKUP_TABLES with the Axiom address lookup table used by the source transaction.",
                  );
                }
                throw error;
              }

              if (!compactAxiom) {
                let swapIxs = volumeIxs.filter((ix) => ix !== jitoTipIx);
              let swapMessageV0;
              try {
                swapMessageV0 = new TransactionMessage({
                  payerKey: user,
                  recentBlockhash: blockhash,
                  instructions: swapIxs,
                }).compileToV0Message(walletLookupTables);
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
                }).compileToV0Message(walletLookupTables);
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
                if (isAxiom) {
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
                }).compileToV0Message(walletLookupTables);
                tx = new VersionedTransaction(compactMessageV0);
                tx.sign([keypair, ...(wallet.extraSigners || [])]);
                try {
                  assertTxSize(tx, "compact swap tx");
                } catch (compactError) {
                  if (
                    !troganTipIx ||
                    troganTipIx.keys[3].pubkey.equals(SystemProgram.programId)
                  ) {
                    throw compactError;
                  }
                  troganTipIx.keys[3].pubkey = SystemProgram.programId;
                  const unmarkedMessageV0 = new TransactionMessage({
                    payerKey: user,
                    recentBlockhash: blockhash,
                    instructions: swapIxs,
                  }).compileToV0Message(walletLookupTables);
                  tx = new VersionedTransaction(unmarkedMessageV0);
                  tx.sign([keypair, ...(wallet.extraSigners || [])]);
                  assertTxSize(tx, "compact swap tx without Trojan marker");
                  console.log(
                    chalk.yellow(
                      "Removed Trojan jitodontfront marker because the swap transaction was too large.",
                    ),
                  );
                }
                console.log(
                  chalk.yellow(
                    "Removed compute budget instructions because swap tx is still too large.",
                  ),
                );
              }

              txInstructions = swapIxs;

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
            }

            let simulationResult = null;
            if (isDevelopmentEnvironment(ctx) || wallet.isGmgn) {
              simulationResult = await connection.simulateTransaction(tx, {
                commitment: "confirmed",
              });
            }

            if (simulationResult && wallet.isPadre && !isProxy) {
              const chainBaseAmountOut = getPadreBuyBaseAmountOut(
                simulationResult.value.logs,
                poolDetail.address,
                user,
              );
              if (chainBaseAmountOut === null || chainBaseAmountOut <= 0n) {
                throw new Error(
                  `Padre Pump AMM quote unavailable: ${JSON.stringify(simulationResult.value.err)} ${JSON.stringify(simulationResult.value.logs || [])}`,
                );
              }
              const { slippageBps, minBaseAmountOut } = getMinBaseAmountOut(
                chainBaseAmountOut,
                slippage,
              );
              const padreRouteIx = txInstructions.find(isPadreRouteInstruction);
              setPadreRouteMinFinalOut(padreRouteIx, minBaseAmountOut);
              const quotedMessageV0 = new TransactionMessage({
                payerKey: user,
                recentBlockhash: blockhash,
                instructions: txInstructions,
              }).compileToV0Message(walletLookupTables);
              tx = new VersionedTransaction(quotedMessageV0);
              tx.sign([keypair, ...(wallet.extraSigners || [])]);
              assertTxSize(tx, "quoted Padre swap tx");
              console.log("PADRE_PUMP_AMM_CHAIN_QUOTE", {
                user: user.toBase58(),
                chainBaseAmountOut: chainBaseAmountOut.toString(),
                minBaseAmountOut: minBaseAmountOut.toString(),
                slippageBps: slippageBps.toString(),
              });
              simulationResult = await connection.simulateTransaction(tx, {
                commitment: "confirmed",
              });
            }

            if (simulationResult?.value?.err) {
              const chainBaseAmountOut = getChainBuyBaseAmountOut(
                simulationResult.value.logs,
              );
              const buyExactQuoteInIx =
                pSwap.getBuyExactQuoteInInstruction(txInstructions);
              const proxyBuyIx = getProxyBuyInstruction(txInstructions);
              const aveBuyIx = buyExactQuoteInIx || proxyBuyIx
                ? null
                : avePumpSwap.getBuyInstruction(txInstructions);
              const quotePatchIx = buyExactQuoteInIx || proxyBuyIx || aveBuyIx;

              if (chainBaseAmountOut !== null && quotePatchIx) {
                const { slippageBps, minBaseAmountOut } = getMinBaseAmountOut(
                  chainBaseAmountOut,
                  slippage,
                );
                if (buyExactQuoteInIx) {
                  pSwap.setBuyExactQuoteInMinBaseAmountOut(
                    buyExactQuoteInIx,
                    minBaseAmountOut,
                  );
                } else if (proxyBuyIx) {
                  setProxyBuyMinBaseAmountOut(proxyBuyIx, minBaseAmountOut);
                } else {
                  avePumpSwap.setBuyMinBaseAmountOut(
                    aveBuyIx,
                    minBaseAmountOut,
                  );
                }

                const quotedMessageV0 = new TransactionMessage({
                  payerKey: user,
                  recentBlockhash: blockhash,
                  instructions: txInstructions,
                }).compileToV0Message(walletLookupTables);
                tx = new VersionedTransaction(quotedMessageV0);
                tx.sign([keypair, ...(wallet.extraSigners || [])]);
                assertTxSize(tx, "chain-quoted swap tx");

                console.log("PUMP_AMM_CHAIN_QUOTE_V2", {
                  route: buyExactQuoteInIx ? "pump_amm" : proxyBuyIx ? "proxy" : "ave",
                  user: user.toBase58(),
                  quoteAmountIn: Math.trunc(
                    Number(buyAmount) * LAMPORTS_PER_SOL,
                  ).toString(),
                  chainBaseAmountOut: chainBaseAmountOut.toString(),
                  minBaseAmountOut: minBaseAmountOut.toString(),
                  slippageBps: slippageBps.toString(),
                });

                simulationResult = await connection.simulateTransaction(tx, {
                  commitment: "confirmed",
                });
              }
            }

            if (simulationResult?.value?.err) {
              console.error("simulation", simulationResult.value);
              throw new Error(
                "Simulation failed: " +
                  JSON.stringify(simulationResult.value.err) +
                  " " +
                  JSON.stringify(simulationResult.value.logs || []),
              );
            }
            if (simulationResult && wallet.isOkx && !isProxy) {
              const amountOut = getOkxAmmAmountOut(simulationResult.value.logs);
              if (amountOut === null || amountOut <= 0n) {
                throw new Error("OKX Pump AMM simulation did not return an output quote");
              }
              setLocalOkxAmmExpectedAmountOut(txInstructions, amountOut);
              const quotedMessageV0 = new TransactionMessage({
                payerKey: user,
                recentBlockhash: blockhash,
                instructions: txInstructions,
              }).compileToV0Message(walletLookupTables);
              tx = new VersionedTransaction(quotedMessageV0);
              tx.sign([keypair, ...(wallet.extraSigners || [])]);
              assertTxSize(tx, "quoted OKX swap tx");
            }
            buyTxns.push({ tx, isAxiom });
            if (splitTipTx) {
              buyTxns.push({ tx: splitTipTx, isAxiom: false });
            }
          } catch (error) {
            console.error(error);
            if (buyTxns.length === 0 || isPadreBundle) {
              throw error;
            }
            break;
          }
        }

        // for end
        console.log("buyTxns", buyTxns.length);
        if (limitedBundleProvider && buyTxns.length > 5) {
          if (wallets.length === 1) {
            throw new Error("One buy requires more than 5 bundle transactions");
          }
          await Promise.all(
            splitIntoBundles(wallets, wallets.length - 1).map((group) =>
              func(group),
            ),
          );
          return;
        }
        if (isDevelopmentEnvironment(ctx) && SIMULATE_BEFORE_BUNDLE) {
          for (let i = 0; i < buyTxns.length; i++) {
            const simulationResult = await connection.simulateTransaction(
              buyTxns[i].tx,
              { commitment: "confirmed" },
            );
            if (simulationResult.value.err) {
              console.error("simulation tx", i, simulationResult.value);
              throw new Error(
                `Simulation failed for tx ${i}: ${JSON.stringify(simulationResult.value.err)}`,
              );
            }
          }
        }
        // return;
        if (buyTxns.length > 0) {
          const allTxns = buyTxns.map((item) => item.tx);
          if (isNozomi) {
            const batchResult = await ctx.service.jito.sendBundle(
              allTxns,
              sendOptions,
            );
            console.log("Pump AMM Nozomi batch result", batchResult);
            console.log(chalk.green("Buy transactions completed."));
            return;
          }
          if (!combineAxiomBuys && buyTxns.some((item) => item.isAxiom)) {
            const axiomTxns = buyTxns
              .filter((item) => item.isAxiom)
              .map((item) => item.tx);
            const bundleTxns = buyTxns
              .filter((item) => !item.isAxiom)
              .map((item) => item.tx);
            const axiomBundleResults = await Promise.all(
              axiomTxns.map((axiomTxn) =>
                ctx.service.jito.sendBundle([axiomTxn], sendOptions),
              ),
            );
            console.log("Axiom bundle results", axiomBundleResults);
            if (bundleTxns.length > 0) {
              const bundleResult = await ctx.service.jito.sendBundle(
                bundleTxns,
                sendOptions,
              );
              console.log("Pump AMM bundle result", bundleResult);
            }
            console.log(chalk.green("Buy transactions completed."));
            return;
          }
          const bundleResult = await ctx.service.jito.sendBundle(
            allTxns,
            sendOptions,
          );
          console.log("Pump AMM combined bundle result", bundleResult);
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

  async batchSellToken(token, wallets, type = "", percent = 100) {
    const { ctx } = this;
    console.log(chalk.green("\n batch sell Token----"));

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
            "sell percent must be greater than 0 and less than or equal to 100",
          );
        }
        return normalizedPercent;
      };

      percent = sellAll ? 100 : Number(percent);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        throw new Error(
          "percent must be greater than 0 and less than or equal to 100",
        );
      }

      const tokenMint = new PublicKey(token);
      const tokenProgramId = await getTokenProgramId(tokenMint);

      let poolDetail;
      try {
        poolDetail = await getPoolsWithPrices(tokenMint, ctx);
      } catch (error) {
        if (error.code !== "NO_WSOL_PUMP_POOL") throw error;
        console.log(
          chalk.yellow(
            `No WSOL Pump AMM pool for ${tokenMint.toBase58()}; routing sell through Jupiter.`,
          ),
        );
        return this.batchSellTokenByJupiter(
          tokenMint,
          wallets,
          tokenProgramId,
          getWalletSellPercent,
        );
      }

      const seenSellWallets = new Set();
      const uniqueWallets = wallets.filter((wallet) => {
        const walletAddress = wallet.keypair.publicKey.toBase58();
        if (seenSellWallets.has(walletAddress)) {
          console.log(
            chalk.yellow(`Skip duplicate sell wallet ${walletAddress}`),
          );
          return false;
        }
        seenSellWallets.add(walletAddress);
        return true;
      });
      const newWallets = (
        await Promise.all(
          uniqueWallets.map(async (wallet) => {
            const keypair = wallet.keypair;
            const user = keypair.publicKey;
            const balance = await getSPLBalance(
              connection,
              tokenMint,
              keypair.publicKey,
              tokenProgramId,
            );
            const sellPercent = getWalletSellPercent(wallet);
            const percentBasisPoints = BigInt(Math.round(sellPercent * 100));
            const balanceRaw = BigInt(Math.trunc(balance * 10 ** 6));
            const tokenAmountRaw = (balanceRaw * percentBasisPoints) / 10000n;
            const tokenAmount = Number(tokenAmountRaw) / 10 ** 6;

            console.log(
              `${user.toBase58()} sell ${tokenAmount} (${sellPercent}%) ${token}`,
            );
            if (tokenAmountRaw >= MIN_SELL_TOKEN_AMOUNT_RAW) {
              return { ...wallet, tokenAmount };
            }
            return null;
          }),
        )
      ).filter(Boolean);

      newWallets.reverse();
      if (newWallets.length === 0) {
        console.log(chalk.yellow("No sellable token balance found; skipping sell."));
        return true;
      }

      const func = async (wallets) => {
        const { blockhash } = await connection.getLatestBlockhash();
        const sellTxns = [];
        const jipAcc = ctx.service.jito.getTipAcc();
        const tipAmount = ctx.service.jito.getTipAmount();
        for (let i = 0; i < wallets.length; i++) {
          const wallet = wallets[i];
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const tokenAmount = wallet.tokenAmount;
          const slippage = wallet.slippage;

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
            slippage,
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
          if (wallets.length > 1 && i === wallets.length - 1) {
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
          ], undefined, { skipPreflight: !isDevelopmentEnvironment(ctx) });
          console.log(signatures);
          console.log(chalk.green("Sell transaction completed."));
        }
        return true;
      };
      const bundles = splitIntoBundles(newWallets);
      // Each send path waits for the submitted transactions to land already.
      for (let i = 0; i < bundles.length; i++) {
        await func(bundles[i]);
      }
      return true;
    } else {
      throw new Error("batch sell Token: param error");
    }
  }

  async batchSellTokenByJupiter(tokenMint, wallets, tokenProgramId, getWalletSellPercent) {
    const { ctx } = this;
    const seen = new Set();
    const uniqueWallets = wallets.filter((wallet) => {
      const address = wallet.keypair.publicKey.toBase58();
      if (seen.has(address)) return false;
      seen.add(address);
      return true;
    });
    const sellWallets = (
      await Promise.all(
        uniqueWallets.map(async (wallet) => {
          const owner = wallet.keypair.publicKey;
          const tokenAccount = getAssociatedTokenAddressSync(
            tokenMint,
            owner,
            false,
            tokenProgramId,
          );
          const accounts = await connection.getParsedTokenAccountsByOwner(
            owner,
            { mint: tokenMint },
            "confirmed",
          );
          const source = accounts.value.find(({ pubkey }) =>
            pubkey.equals(tokenAccount),
          );
          const balanceRaw = source
            ? BigInt(source.account.data.parsed.info.tokenAmount.amount)
            : 0n;
          const percentBasisPoints = BigInt(
            Math.round(getWalletSellPercent(wallet) * 100),
          );
          const amountRaw = (balanceRaw * percentBasisPoints) / 10000n;
          return amountRaw >= MIN_SELL_TOKEN_AMOUNT_RAW
            ? { wallet, amountRaw }
            : null;
        }),
      )
    ).filter(Boolean);
    if (sellWallets.length === 0) return true;

    for (const batch of splitIntoBundles(sellWallets.reverse())) {
      const prepared = await Promise.all(
        batch.map(async ({ wallet, amountRaw }, index) => {
          const keypair = wallet.keypair;
          const user = keypair.publicKey;
          const swapData = await getJupiterSellInstructions(ctx, {
            user,
            tokenMint,
            tokenAmount: amountRaw.toString(),
            slippage: wallet.slippage ?? 0.3,
            connection,
          });
          const instructions = [...swapData.instructions];
          if (batch.length > 1 && index === 0) {
            instructions.push(
              SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: ctx.service.jito.getTipAcc(),
                lamports: ctx.service.jito.getTipAmount(),
              }),
            );
          }
          return {
            keypair,
            user,
            instructions,
            lookupTableAccounts: swapData.lookupTableAccounts,
          };
        }),
      );

      // Quotes and lookup tables can take time; sign with a fresh blockhash.
      const { blockhash } = await connection.getLatestBlockhash();
      const transactions = [];
      for (const { keypair, user, instructions, lookupTableAccounts } of prepared) {
        const message = new TransactionMessage({
          payerKey: user,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message(lookupTableAccounts);
        const transaction = new VersionedTransaction(message);
        transaction.sign([keypair]);
        if (transaction.serialize().length > MAX_TRANSACTION_SIZE) {
          throw new Error(`Jupiter sell transaction is too large for ${user.toBase58()}`);
        }
        transactions.push(transaction);
      }
      if (isDevelopmentEnvironment(ctx)) {
        await Promise.all(transactions.map(async (transaction, i) => {
          const signature = bs58.encode(Buffer.from(transaction.signatures[0]));
          const user = prepared[i].user.toBase58();
          let simulation;
          try {
            simulation = await connection.simulateTransaction(transaction, {
              commitment: "confirmed",
              replaceRecentBlockhash: true,
            });
          } catch (error) {
            throw new Error(`Jupiter sell simulation RPC failed for ${user} (${signature}): ${error.message}`, {
              cause: error,
            });
          }
          console.log("Jupiter sell simulation", {
            user,
            signature,
            slot: simulation.context?.slot,
            unitsConsumed: simulation.value?.unitsConsumed,
            err: simulation.value?.err,
            logs: simulation.value?.logs,
          });
          if (!simulation.value || simulation.value.err) {
            throw new Error(`Jupiter sell simulation failed for ${user} (${signature}): ${JSON.stringify(simulation.value?.err || "empty result")} ${JSON.stringify(simulation.value?.logs || [])}`);
          }
        }));
      }
      if (transactions.length > 1) {
        await ctx.service.jito.sendBundle(transactions);
      } else {
        await ctx.service.jito.sendTransactionsByRpc(
          transactions,
          undefined,
          { skipPreflight: !isDevelopmentEnvironment(ctx) },
        );
      }
    }
    return true;
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

    const userVolumeAccumulator = getUserVolumeAccumulatorPda(user);
    const cashbackAta = getAssociatedTokenAddressSync(
      WSOL_TOKEN_ACCOUNT,
      userVolumeAccumulator,
      true,
      TOKEN_PROGRAM_ID,
    );
    const createCashbackAtaIx = poolDetail.poolData.is_cashback
      ? createAssociatedTokenAccountIdempotentInstruction(
          user,
          cashbackAta,
          userVolumeAccumulator,
          WSOL_TOKEN_ACCOUNT,
          TOKEN_PROGRAM_ID,
        )
      : null;

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
      ...(createCashbackAtaIx ? [createCashbackAtaIx] : []),
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
    const { buyAmount } = wallet;
    if (wallet.isProxy === true) {
      const proxyIxs = await this.getBuyAmmIxs({
        tokenMint,
        user,
        buyAmount,
        poolDetail,
        slippage,
        tokenProgramId,
      });
      const pumpBuyIx = pSwap.getBuyExactQuoteInInstruction(proxyIxs);
      if (!pumpBuyIx) {
        throw new Error("Pump AMM buy_exact_quote_in instruction missing");
      }
      const proxyBuyIx = await createProxyBuyInstruction({
        user,
        tokenMint,
        buyAmount,
        poolDetail,
        tokenProgramId,
      });
      proxyBuyIxs = proxyIxs.map((ix) => ix === pumpBuyIx ? proxyBuyIx : ix);
    } else if (isAxiom) {
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

  async genPadreBuyIxs({
    tokenMint,
    wallet,
    poolDetail,
    slippage,
    tokenProgramId,
  }) {
    if (!poolDetail) {
      throw new Error("Padre Pump AMM route requires pool detail");
    }
    const user = wallet.keypair.publicKey;
    const { inputTokenAccount, outputTokenAccount } = getPadreSwapAccounts(
      user,
      tokenMint,
      tokenProgramId,
    );
    const buyAmount = Number(wallet.buyAmount);
    if (!Number.isFinite(buyAmount) || buyAmount <= 0) {
      throw new Error("Padre buyAmount must be a positive number");
    }
    const totalAmountLamports = BigInt(
      Math.trunc(buyAmount * LAMPORTS_PER_SOL),
    );
    const buyAmountLamports = totalAmountLamports *
      (10000n - BigInt(PADRE_FEE_BASIS_POINTS)) / 10000n;
    if (buyAmountLamports === 0n ||
        buyAmountLamports * BigInt(PADRE_FEE_BASIS_POINTS) / 10000n === 0n) {
      throw new Error("Padre buyAmount must be at least one lamport");
    }
    const hopKeys = createPadrePumpAmmHopKeys({
      tokenMint,
      user,
      inputTokenAccount,
      outputTokenAccount,
      poolDetail,
    });
    const padreInstruction = createPadreRouteInstruction({
      user,
      inputAmount: buyAmountLamports,
      // Probe the exact Pump AMM output in simulation before setting the
      // slippage floor on the signed transaction.
      minFinalOut: 0n,
      inputTokenAccount,
      outputTokenAccount,
      outputMint: tokenMint,
      hopKeys,
      hopProtocol: 3,
      feeBasisPoints: PADRE_FEE_BASIS_POINTS,
      feeRecipient: PADRE_FEE_RECIPIENT,
    });
    const nonceAccount = getPadreNonceAccount(user);
    const nonceInfo = await connection.getAccountInfo(nonceAccount, "confirmed");
    return [
      ...createPadreNonceInstructions(user, undefined, !!nonceInfo),
      padreInstruction,
    ];
  }
}

module.exports = PumpAMM;
