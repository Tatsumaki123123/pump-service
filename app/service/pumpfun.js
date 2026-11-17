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
const JupSDK = require("../libs/jup");
const { getCurveQuote } = require("../libs/pumpCurve");
const {
  dedupeIdempotentInstructions,
  compileWithSizeFallback: compileTxWithSizeFallback,
  findVoteAccounts,
} = require("../libs/txInstructions");
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
  getAssociatedTokenAddressSync,
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
const jupSwap = new JupSDK();

// token -> { at, excludeDexes }：记录「这个币的 jup 路由要排除哪些 DEX」。
// 只复用排除项，探测本身每笔都做（Jupiter 的路由几秒就会变）。
const jupRouteMarkerCache = new Map();
const JUP_ROUTE_MARKER_TTL_MS = 2 * 60 * 1000;
// true = 宁可不下单也不降级逐笔发送（bundle 被 vote 标记拒收时直接报错）
const REQUIRE_BUNDLE = process.env.PUMP_REQUIRE_BUNDLE === "true";

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
  const associatedQuoteBondingCurve = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    keys[3].pubkey,
    true,
    TOKEN_PROGRAM_ID,
  );
  return [
    readonly(PUMP_FUN_PROGRAM_ID),
    keys[3],
    keys[0],
    keys[2],
    readonly(NATIVE_MINT),
    { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
    { ...keys[5], isSigner: false },
    keys[17],
    keys[4],
    { pubkey: associatedQuoteBondingCurve, isSigner: false, isWritable: true },
    { ...keys[1], isSigner: false },
    keys[13],
    keys[14],
    keys[10],
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

// Jupiter 的接口要的是 0~1 的小数滑点，这里把内盘统一用的 bps 转回去
function getWalletSlippageFraction(wallet) {
  return Number(getWalletSlippageBasisPoints(wallet)) / 10000;
}

/** 包一层日志，调用处就不用每次传 chalk */
function dedupeIxs(instructions, label) {
  return dedupeIdempotentInstructions(
    instructions,
    (message) => console.log(chalk.yellow(message)),
    label,
  ).instructions;
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

  /**
   * 读取 checkToken 落库的路由标记。
   *
   * 曲线本身可以用非 SOL 的计价单位（另一个 pump 币 / 稳定币），
   * 这种曲线用普通 buy/sell 发出去必然报 6063 UnsupportedQuoteMint ——
   * 旧 SDK 把 virtual_quote_reserves 当 SOL 在用，看不出区别。
   *
   * 所以 DB 里没有标记时，再读一次链上曲线的 quote_mint 兜底：
   * 非 SOL 就改走 Jupiter，并把标记回填到库里。
   */
  async getJupRouteInfo(token) {
    const { ctx } = this;
    try {
      const row = await ctx.model.ExecuteToken.findOne(
        { token },
        { useJup: 1, quoteMint: 1, routeInfo: 1 },
      ).lean();
      const routeInfo = row?.routeInfo || {};
      const result = {
        useJup: row?.useJup === true || routeInfo.useJup === true,
        quoteMint: row?.quoteMint || routeInfo.quoteMint || "",
        routeInfo,
      };
      if (result.useJup) return result;

      const curveQuote = await getCurveQuote(connection, token).catch(() => null);
      if (!curveQuote || curveQuote.isSolQuote) return result;

      result.useJup = true;
      result.quoteMint = curveQuote.quoteMint;
      console.log(
        chalk.yellow(
          `Pump.fun 曲线 ${token} 的 quote_mint 非 SOL（${curveQuote.quoteMint}），改用 Jupiter 并回填标记`,
        ),
      );
      // 回填，下一轮不用再查链。失败不影响本次交易
      ctx.model.ExecuteToken.updateOne(
        { token },
        { $set: { useJup: true, quoteMint: curveQuote.quoteMint } },
      ).catch(() => undefined);
      return result;
    } catch (error) {
      console.log(
        chalk.yellow(
          `Cannot read route info for ${token}: ${error.message}; keeping Pump curve route`,
        ),
      );
      return { useJup: false, quoteMint: "", routeInfo: {} };
    }
  }

  /**
   * jup 路由里带上 vote 账户时（暗池拿它当反 bundle 标记，例如
   * J1to1yufRnoWn81KYg1XkTWzmKjnYSnmE2VY8DGUJ9Qv），Jito 一律拒收 bundle。
   *
   * 处理方式：边排边试，最多 3 轮——每轮把当前路由里「除 Pump.fun 以外」的
   * DEX 全部加进排除列表重建，然后重新探测。
   * 排到无可排（说明标记来自 Pump 跳本身，或者这币只有这一条路）就回退原路由，
   * 交给发送阶段的逐笔降级，并把结论写进日志。
   */
  async rebuildJupWithoutVoteMarkers(ctx, token, wallets, prefetched, buildOne) {
    if (!prefetched.length) return prefetched;
    // 缓存只复用「已经排除了哪些 DEX」，绝不跳过探测 ——
    // Jupiter 几秒内就会换路由（Whirlpool > Pump.fun 可能变成 BisonFi > Byreal > Pump.fun），
    // 上一笔干净不代表这一笔干净。
    const cached = jupRouteMarkerCache.get(token);
    const fresh = cached && Date.now() - cached.at < JUP_ROUTE_MARKER_TTL_MS;
    const excluded = new Set(
      fresh && cached.excludeDexes
        ? cached.excludeDexes.split(",").filter(Boolean)
        : [],
    );
    let current = prefetched;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const labels = [
        ...new Set(current.flatMap((item) => item.routeLabels || [])),
      ];
      const probe = this.buildProbeTx(wallets[0], current[0]);
      if (!probe) return prefetched;

      const marked = await findVoteAccounts(connection, [probe]).catch(() => []);
      if (!marked.length) {
        if (excluded.size) {
          console.log(
            chalk.green(
              `[bundle] 排除 ${[...excluded].join(",")} 后路由干净：${labels.join(" > ")}`,
            ),
          );
        }
        jupRouteMarkerCache.set(token, {
          at: Date.now(),
          excludeDexes: [...excluded].join(","),
        });
        return current;
      }

      const candidates = labels.filter(
        (label) => !/^pump/i.test(label) && !excluded.has(label),
      );
      if (!candidates.length) {
        console.log(
          chalk.red(
            `[bundle] ${token} 路由 ${labels.join(" > ") || "unknown"} 带 vote 账户 ${marked[0]}，` +
              "已无可排除的 DEX —— 标记来自 Pump 跳本身或这是唯一可用路由，bundle 走不了",
          ),
        );
        jupRouteMarkerCache.set(token, {
          at: Date.now(),
          excludeDexes: [...excluded].join(","),
        });
        return prefetched;
      }

      candidates.forEach((label) => excluded.add(label));
      try {
        current = await Promise.all(
          wallets.map((wallet) => buildOne(wallet, [...excluded].join(","))),
        );
        console.log(
          chalk.yellow(
            `[bundle] 第 ${attempt + 1} 轮排除 ${[...excluded].join(",")} 后重建：${
              (current[0]?.routeLabels || []).join(" > ") || "unknown"
            }`,
          ),
        );
      } catch (error) {
        console.log(
          chalk.yellow(
            `[bundle] 排除 ${[...excluded].join(",")} 后无可用路由（${error.message}），回退原路由`,
          ),
        );
        return prefetched;
      }
    }

    console.log(
      chalk.red(`[bundle] ${token} 连续 3 轮排除后仍带 vote 账户，回退原路由`),
    );
    return prefetched;
  }

  /** 只用来检查账户构成，不签名也不发送 */
  buildProbeTx(wallet, jupData) {
    if (!jupData || !wallet?.keypair) return null;
    try {
      const tables = jupData.lookupTableAccounts?.length
        ? jupData.lookupTableAccounts
        : undefined;
      return new VersionedTransaction(
        new TransactionMessage({
          payerKey: wallet.keypair.publicKey,
          recentBlockhash: "11111111111111111111111111111111",
          instructions: jupData.instructions,
        }).compileToV0Message(tables),
      );
    } catch (error) {
      return null;
    }
  }

  async batchBuyToken(token, wallets, type = "", sendOptions = {}) {
    const { ctx } = this;
    console.log(chalk.green("\nPump fun batchBuyToken----", wallets.length));
    if (token && wallets) {
      const tokenMint = new PublicKey(token);
      // 非 WSOL 计价的池子：内盘曲线指令无法成交，全部钱包改走 Jupiter
      const jupRoute = await this.getJupRouteInfo(token);
      if (jupRoute.useJup) {
        console.log(
          chalk.yellow(
            `Pump.fun 内盘 ${token} 计价单位非 WSOL (${jupRoute.quoteMint || "unknown"})，本批全部改走 Jupiter 买入`,
          ),
        );
      }
      const isNozomi =
        String(sendOptions.batchPlatform || "").toLowerCase() === "nozomi";
      const { blockhash } = await connection.getLatestBlockhash();
      const buyTxns = [];
      // 走 Jupiter 时不再需要曲线账户，专用路由的曲线预计算也一并跳过
      const allAxiomWallets =
        !jupRoute.useJup && wallets.every((wallet) => wallet.isAxiom);
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
      // 在 blockhash 有效期开始前把 Jupiter 报价一次取全，避免逐个钱包串行等 HTTP
      const buildJupBuy = (wallet, excludeDexes) =>
        jupSwap.getBuyInstructions(ctx, {
          user: wallet.keypair.publicKey,
          tokenMint,
          buyAmount: wallet.buyAmount,
          slippage: getWalletSlippageFraction(wallet),
          connection,
          excludeDexes,
        });
      // 已知要排除哪些 DEX 时先用结论取价，省掉重建的一轮报价
      const markedRoute = jupRoute.useJup ? jupRouteMarkerCache.get(token) : null;
      const cachedExclude =
        markedRoute && Date.now() - markedRoute.at < JUP_ROUTE_MARKER_TTL_MS
          ? markedRoute.excludeDexes || undefined
          : undefined;

      let jupBuyData = [];
      if (jupRoute.useJup) {
        try {
          jupBuyData = await Promise.all(
            wallets.map((wallet) => buildJupBuy(wallet, cachedExclude)),
          );
        } catch (error) {
          // 缓存里的排除项可能把路由排没了，退回默认路由再取一次
          if (!cachedExclude) throw error;
          console.log(
            chalk.yellow(
              `[bundle] 用缓存排除 ${cachedExclude} 取价失败（${error.message}），改为默认路由`,
            ),
          );
          jupRouteMarkerCache.delete(token);
          jupBuyData = await Promise.all(
            wallets.map((wallet) => buildJupBuy(wallet)),
          );
        }
      }
      if (jupRoute.useJup) {
        if (jupBuyData[0]?.routeLabels?.length) {
          console.log(
            chalk.gray(`[jup] route ${jupBuyData[0].routeLabels.join(" > ")}`),
          );
        }
        // 每笔都要探测：Jupiter 几秒内就会换路由，上一笔干净不代表这一笔干净
        jupBuyData = await this.rebuildJupWithoutVoteMarkers(
          ctx,
          token,
          wallets,
          jupBuyData,
          buildJupBuy,
        );
      }
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        const keypair = wallet.keypair;
        const user = keypair.publicKey;
        const { buyAmount, limit, price, fee } = wallet;
        const slippageBasisPoints = getWalletSlippageBasisPoints(wallet);
        let volumeIxs = [];
        let walletLookupTables;
        console.log(`${user.toBase58()} buy ${buyAmount} ${token}`);
        if (jupRoute.useJup) {
          const jupData = jupBuyData[i];
          if (!jupData) {
            throw new Error(`Jupiter buy route unavailable for ${token}`);
          }
          if (jupData.lookupTableAccounts?.length) {
            walletLookupTables = jupData.lookupTableAccounts;
          }
          // Jupiter 在 dynamicComputeUnitLimit 下自带 setComputeUnitLimit，
          // 再塞一条自己的只会被它的覆盖，还可能撞上运行时「重复指令」检查。
          // 优先级费仍然用钱包配置的那条。
          volumeIxs = [
            ...(price
              ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })]
              : []),
            ...jupData.instructions,
          ];
        } else if (wallet.isGmgn) {
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
        const isPadreRoute = wallet.isPadre || wallet.isPardre;
        const shouldIncludePadreBundleTip =
          !isPadreRoute || isNozomi || wallets.length > 1;
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

        // 记下 tip 指令的引用，交易超限时可能要把它拆到单独一笔
        let bundleTipIx = null;
        if (shouldIncludePadreBundleTip && !isNozomi && i === 0) {
          const configuredTipLamports = Number(fee) * LAMPORTS_PER_SOL;
          bundleTipIx = SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: jipAcc,
            lamports:
              Number.isFinite(configuredTipLamports) &&
              configuredTipLamports > 0
                ? configuredTipLamports
                : tipAmount,
          });
          volumeIxs.push(bundleTipIx);
        }

        if (
          isNozomi &&
          !wallet.isAxiom &&
          !wallet.isGmgn
        ) {
          bundleTipIx = SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: jipAcc,
            lamports: tipAmount,
          });
          volumeIxs.push(bundleTipIx);
        }

        try {
          // jup 拼出来的指令要先去掉重复，运行时不允许同一笔交易出现两条
          // 完全相同的指令，否则模拟阶段就直接报 duplicate instruction
          const preparedIxs = jupRoute.useJup
            ? dedupeIxs(volumeIxs, `buy ${token}`)
            : volumeIxs;
          // 多跳路由容易顶到 1232 字节上限，这里按体积逐级瘦身
          const { transaction: tx, tipDropped } = compileTxWithSizeFallback({
            payerKey: user,
            recentBlockhash: blockhash,
            instructions: preparedIxs,
            lookupTables: walletLookupTables,
            tipInstruction: bundleTipIx,
            label: `buy ${token}`,
            log: (message) => console.log(chalk.yellow(message)),
          });
          tx.sign([keypair]);
          await simulatePumpFunTransaction(tx, user, ctx);
          if (jupRoute.useJup && !isDevelopmentEnvironment(ctx)) {
            // Jupiter 是外部报价，发之前自己再模拟一次，别把注定失败的交易塞进 bundle
            const simulated = await connection.simulateTransaction(tx, {
              commitment: "confirmed",
            });
            if (!simulated.value || simulated.value.err) {
              throw new Error(
                `Jupiter buy simulation failed for ${user.toBase58()}: ${JSON.stringify(
                  simulated.value?.err || "empty result",
                )}`,
              );
            }
          }
          buyTxns.push(tx);
          if (tipDropped && bundleTipIx) {
            // 交易太大时 tip 被摘出来了，补一笔单独的 tip 交易，
            // 否则 jito bundle 没有小费会被拒
            const tipTx = new VersionedTransaction(
              new TransactionMessage({
                payerKey: user,
                recentBlockhash: blockhash,
                instructions: [bundleTipIx],
              }).compileToV0Message(),
            );
            tipTx.sign([keypair]);
            buyTxns.push(tipTx);
            console.log(
              chalk.yellow(`[size] buy ${token} tip 已拆成独立交易`),
            );
          }
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
        try {
          const bundleResult = await ctx.service.jito.sendBundle(
            buyTxns,
            sendOptions,
          );
          console.log(bundleResult);
          console.log(chalk.green("Buy transactions completed."));
          return true;
        } catch (error) {
          // bundle 被拒是因为交易里锁了 vote 账户时，定位一下再降级逐笔发送：
          // 某些池子拿 vote 账户当反 bundle 标记，路由命中就会带上，
          // 这种交易永远进不了 bundle，但单独发是合法的。
          if (!/vote account/i.test(error.message)) throw error;
          const voteAccounts = await findVoteAccounts(connection, buyTxns).catch(
            () => [],
          );
          if (REQUIRE_BUNDLE) {
            throw new Error(
              `[bundle] ${token} 交易带 vote 账户 ${
                voteAccounts.join(", ") || "(未定位到)"
              }，PUMP_REQUIRE_BUNDLE=true 时不允许降级逐笔发送`,
            );
          }
          console.error(
            chalk.red(
              `[bundle] ${token} 交易里含 vote 账户 ${voteAccounts.join(", ") || "(未定位到，可能是 ALT 内账户)"}；` +
                "Jito 不允许打包，降级为逐笔发送。可在 JUPITER_EXCLUDE_DEXES 里排除对应 DEX 避免",
            ),
          );
          for (const transaction of buyTxns) {
            const signature = await connection.sendTransaction(transaction, {
              skipPreflight: !isDevelopmentEnvironment(ctx),
            });
            await connection.confirmTransaction(signature, "processed");
            console.log(chalk.yellow(`  sent ${signature} (no bundle)`));
          }
          return true;
        }
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
      // 非 WSOL 计价的池子：卖出同样走 Jupiter（token -> SOL）
      const jupRoute = await this.getJupRouteInfo(token);
      if (jupRoute.useJup) {
        console.log(
          chalk.yellow(
            `Pump.fun 内盘 ${token} 计价单位非 WSOL (${jupRoute.quoteMint || "unknown"})，卖出改走 Jupiter`,
          ),
        );
      }
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
      newWallets.reverse();

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
          let walletLookupTables;
          const jitoTipIx = SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: jipAcc,
            lamports: fee * LAMPORTS_PER_SOL,
          });
          if (jupRoute.useJup) {
            // 非 WSOL 池子用 Jupiter 卖出，结算币种仍回到 SOL
            const jupSell = await jupSwap.getSellInstructions(ctx, {
              user,
              tokenMint,
              tokenAmount: Math.trunc(tokenAmount * Math.pow(10, 6)),
              slippage: Number(slippageBasisPoints) / 10000,
              connection,
            });
            if (jupSell.lookupTableAccounts?.length) {
              walletLookupTables = jupSell.lookupTableAccounts;
            }
            volumeIxs = [
              // ComputeUnitLimit 由 Jupiter 自己的 dynamicComputeUnitLimit 给，
              // 这里只保留优先级费
              ...(price
                ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })]
                : []),
              ...jupSell.instructions,
              jitoTipIx,
            ];
          } else {
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
            volumeIxs = [...sellTx.instructions, jitoTipIx];
          }

          try {
            const preparedIxs = jupRoute.useJup
              ? dedupeIxs(volumeIxs, `sell ${token}`)
              : volumeIxs;
            const { transaction: tx, tipDropped } = compileTxWithSizeFallback({
              payerKey: keypair.publicKey,
              recentBlockhash: blockhash,
              instructions: preparedIxs,
              lookupTables: walletLookupTables,
              tipInstruction: jitoTipIx,
              label: `sell ${token}`,
              log: (message) => console.log(chalk.yellow(message)),
            });
            tx.sign([keypair]);
            await simulatePumpFunTransaction(tx, user, ctx);
            sellTxns.push(tx);
            if (tipDropped) {
              const tipTx = new VersionedTransaction(
                new TransactionMessage({
                  payerKey: user,
                  recentBlockhash: blockhash,
                  instructions: [jitoTipIx],
                }).compileToV0Message(),
              );
              tipTx.sign([keypair]);
              sellTxns.push(tipTx);
              console.log(chalk.yellow(`[size] sell ${token} tip 已拆成独立交易`));
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
          try {
            const bundleResult = await ctx.service.jito.sendBundle(sellTxns);
            console.log(bundleResult);
            console.log(chalk.green("Sell transactions completed."));
          } catch (error) {
            if (!/vote account/i.test(error.message)) throw error;
            const voteAccounts = await findVoteAccounts(
              connection,
              sellTxns,
            ).catch(() => []);
            console.error(
              chalk.red(
                `[bundle] ${token} 卖出的交易里含 vote 账户 ${voteAccounts.join(", ") || "(未定位到)"}；` +
                  "Jito 不允许打包，降级为逐笔发送",
              ),
            );
            for (const transaction of sellTxns) {
              const signature = await connection.sendTransaction(transaction, {
                skipPreflight: !isDevelopmentEnvironment(ctx),
              });
              await connection.confirmTransaction(signature, "processed");
              console.log(chalk.yellow(`  sent ${signature} (no bundle)`));
            }
          }
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
