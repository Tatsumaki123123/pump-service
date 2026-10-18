"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PumpFunSDK =
  exports.DEFAULT_DECIMALS =
  exports.METADATA_SEED =
  exports.CREATOR_VAULT_SEED =
  exports.BONDING_CURVE_SEED =
  exports.MINT_AUTHORITY_SEED =
  exports.GLOBAL_ACCOUNT_SEED =
    void 0;
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@coral-xyz/anchor");
const globalAccount_1 = require("./globalAccount");
const events_1 = require("./events");
const spl_token_1 = require("@solana/spl-token");
const bondingCurveAccount_1 = require("./bondingCurveAccount");
const bn_js_1 = require("bn.js");
const util_1 = require("./util");
const IDL_1 = require("./IDL");
const PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_PROGRAM_ID = new web3_js_1.PublicKey(PROGRAM_ID);
const PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR_SEED = "global_volume_accumulator";
const PUMPFUN_USER_VOLUME_ACCUMULATOR_SEED = "user_volume_accumulator";
const PUMPFUN_EVENT_AUTHORITY = new web3_js_1.PublicKey(
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"
);
const PUMPFUN_FEE_CONFIG = new web3_js_1.PublicKey(
  process.env.PUMPFUN_FEE_CONFIG ||
    "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt"
);
const PUMPFUN_FEE_PROGRAM = new web3_js_1.PublicKey(
  process.env.PUMPFUN_FEE_PROGRAM ||
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
);
const PUMPFUN_EXTRA_ACCOUNT = new web3_js_1.PublicKey(
  process.env.PUMPFUN_EXTRA_ACCOUNT ||
    "Aybh3ZbgfBR8SDiGjFtr2tXofM6a2H7pWZ6VSaqg7Rwk"
);
const PUMPFUN_BUYBACK_ACCOUNT = new web3_js_1.PublicKey(
  process.env.PUMPFUN_BUYBACK_ACCOUNT ||
    "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD"
);
const PUMPFUN_BUY_DISCRIMINATOR = Buffer.from([
  102, 6, 61, 18, 1, 218, 235, 234,
]);
const PUMPFUN_SELL_DISCRIMINATOR = Buffer.from([
  51, 230, 133, 164, 1, 127, 131, 173,
]);
const MPL_TOKEN_METADATA_PROGRAM_ID =
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
exports.GLOBAL_ACCOUNT_SEED = "global";
exports.MINT_AUTHORITY_SEED = "mint-authority";
exports.BONDING_CURVE_SEED = "bonding-curve";
exports.CREATOR_VAULT_SEED = "creator-vault";
exports.METADATA_SEED = "metadata";
exports.DEFAULT_DECIMALS = 6;
class PumpFunSDK {
  program;
  connection;
  constructor(provider) {
    this.program = new anchor_1.Program(IDL_1.IDL, provider);
    this.connection = this.program.provider.connection;
  }
  async createAndBuy(
    creator,
    mint,
    createTokenMetadata,
    buyAmountSol,
    slippageBasisPoints = 500n,
    priorityFees,
    commitment = util_1.DEFAULT_COMMITMENT,
    finality = util_1.DEFAULT_FINALITY
  ) {
    // let tokenMetadata = await this.createTokenMetadata(createTokenMetadata);
    let createTx = await this.getCreateInstructions(
      creator,
      createTokenMetadata.name,
      createTokenMetadata.symbol,
      createTokenMetadata.metadataUri,
      mint
    );
    let newTx = new web3_js_1.Transaction().add(createTx);
    if (buyAmountSol > 0) {
      const globalAccount = await this.getGlobalAccount(commitment);
      const buyAmount = globalAccount.getInitialBuyPrice(buyAmountSol);
      const buyAmountWithSlippage = (0, util_1.calculateWithSlippageBuy)(
        buyAmountSol,
        slippageBasisPoints
      );
      const buyTx = await this.getBuyInstructions(
        creator,
        mint.publicKey,
        globalAccount.feeRecipient,
        buyAmount,
        buyAmountWithSlippage,
        creator,
        commitment
      );
      newTx.add(buyTx);
    }
    let createResults = await (0, util_1.returnTx)(newTx, priorityFees);
    return createResults;
  }
  async buy(
    buyer,
    mint,
    buyAmountSol,
    slippageBasisPoints = 500n,
    priorityFees,
    commitment = util_1.DEFAULT_COMMITMENT,
    finality = util_1.DEFAULT_FINALITY
  ) {
    let buyTx = await this.getBuyInstructionsBySolAmount(
      buyer,
      mint,
      buyAmountSol,
      slippageBasisPoints,
      commitment
    );
    let buyResults = await (0, util_1.returnTx)(buyTx, priorityFees);
    return buyResults;
  }
  async sell(
    seller,
    mint,
    sellTokenAmount,
    slippageBasisPoints = 500n,
    priorityFees,
    commitment = util_1.DEFAULT_COMMITMENT,
    finality = util_1.DEFAULT_FINALITY
  ) {
    let sellTx = await this.getSellInstructionsByTokenAmount(
      seller,
      mint,
      sellTokenAmount,
      slippageBasisPoints,
      commitment
    );
    let sellResults = await (0, util_1.returnTx)(sellTx, priorityFees);
    return sellResults;
  }
  //create token instructions
  async getCreateInstructions(creator, name, symbol, uri, mint) {
    const mplTokenMetadata = new web3_js_1.PublicKey(
      MPL_TOKEN_METADATA_PROGRAM_ID
    );
    const [metadataPDA] = web3_js_1.PublicKey.findProgramAddressSync(
      [
        Buffer.from(exports.METADATA_SEED),
        mplTokenMetadata.toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      mplTokenMetadata
    );
    const associatedBondingCurve = await (0,
    spl_token_1.getAssociatedTokenAddress)(
      mint.publicKey,
      this.getBondingCurvePDA(mint.publicKey),
      true
    );
    return this.program.methods
      .create(name, symbol, uri, creator)
      .accounts({
        mint: mint.publicKey,
        // @ts-ignore
        associatedBondingCurve: associatedBondingCurve,
        metadata: metadataPDA,
        user: creator,
      })
      .signers([mint])
      .transaction();
  }
  async getBuyInstructionsBySolAmount(
    buyer,
    mint,
    buyAmountSol,
    slippageBasisPoints = 500n,
    commitment = util_1.DEFAULT_COMMITMENT,
    bondingCurveAccount
  ) {
    if (!bondingCurveAccount) {
      bondingCurveAccount = await this.getBondingCurveAccount(mint, commitment);
    }
    if (!bondingCurveAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }
    let buyAmount = bondingCurveAccount.getBuyPrice(buyAmountSol);
    let buyAmountWithSlippage = (0, util_1.calculateWithSlippageBuy)(
      buyAmountSol,
      slippageBasisPoints
    );
    let globalAccount = await this.getGlobalAccount(commitment);
    return await this.getBuyInstructions(
      buyer,
      mint,
      globalAccount.feeRecipient,
      buyAmount,
      buyAmountWithSlippage,
      bondingCurveAccount.creator,
      commitment
    );
  }
  //buy
  async getBuyInstructions(
    buyer,
    mint,
    feeRecipient,
    amount,
    solAmount,
    bondingCurveCreator,
    commitment = util_1.DEFAULT_COMMITMENT
  ) {
    const mintInfo = await this.connection.getAccountInfo(mint, commitment);
    if (!mintInfo) {
      throw new Error(`Mint account not found: ${mint.toBase58()}`);
    }
    const tokenProgram = mintInfo.owner.equals(
      spl_token_1.TOKEN_2022_PROGRAM_ID
    )
      ? spl_token_1.TOKEN_2022_PROGRAM_ID
      : spl_token_1.TOKEN_PROGRAM_ID;
    const bondingCurve = this.getBondingCurvePDA(mint);
    const associatedBondingCurve = (0,
    spl_token_1.getAssociatedTokenAddressSync)(
      mint,
      bondingCurve,
      true,
      tokenProgram
    );
    const associatedUser = await (0, spl_token_1.getAssociatedTokenAddress)(
      mint,
      buyer,
      false,
      tokenProgram
    );
    let transaction = new web3_js_1.Transaction();
    try {
      await (0, spl_token_1.getAccount)(
        this.connection,
        associatedUser,
        commitment,
        tokenProgram
      );
    } catch (e) {
      transaction.add(
        (0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(
          buyer,
          associatedUser,
          buyer,
          mint,
          tokenProgram
        )
      );
    }

    const [globalVolumeAccumulator] = web3_js_1.PublicKey.findProgramAddressSync(
      [Buffer.from(PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR_SEED)],
      PUMP_PROGRAM_ID
    );
    const [userVolumeAccumulator] = web3_js_1.PublicKey.findProgramAddressSync(
      [Buffer.from(PUMPFUN_USER_VOLUME_ACCUMULATOR_SEED), buyer.toBuffer()],
      PUMP_PROGRAM_ID
    );
    const key = (pubkey, isWritable = false, isSigner = false) => ({
      pubkey,
      isWritable,
      isSigner,
    });
    const data = Buffer.alloc(24);
    PUMPFUN_BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amount.toString()), 8);
    data.writeBigUInt64LE(BigInt(solAmount.toString()), 16);
    transaction.add(
      new web3_js_1.TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        data,
        keys: [
          key(
            web3_js_1.PublicKey.findProgramAddressSync(
              [Buffer.from(exports.GLOBAL_ACCOUNT_SEED)],
              PUMP_PROGRAM_ID
            )[0]
          ),
          key(feeRecipient, true),
          key(mint),
          key(bondingCurve, true),
          key(associatedBondingCurve, true),
          key(associatedUser, true),
          key(buyer, true, true),
          key(web3_js_1.SystemProgram.programId),
          key(tokenProgram),
          key(this.getCreatorVaultPDA(bondingCurveCreator), true),
          key(PUMPFUN_EVENT_AUTHORITY),
          key(PUMP_PROGRAM_ID),
          key(globalVolumeAccumulator, true),
          key(userVolumeAccumulator, true),
          key(PUMPFUN_FEE_CONFIG, true),
          key(PUMPFUN_FEE_PROGRAM, true),
          key(PUMPFUN_EXTRA_ACCOUNT),
          key(PUMPFUN_BUYBACK_ACCOUNT, true),
        ],
      })
    );
    return transaction;
  }
  async getBuyInstructions2(
    buyer,
    mint,
    feeRecipient,
    amount,
    solAmount,
    commitment = util_1.DEFAULT_COMMITMENT
  ) {
    const bondingCurveAccount = await this.getBondingCurveAccount(
      mint,
      commitment,
    );
    if (!bondingCurveAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }
    return await this.getBuyInstructions(
      buyer,
      mint,
      feeRecipient,
      amount,
      solAmount,
      bondingCurveAccount.creator,
      commitment,
    );
  }
  async getQuickBuyInstructions(
    buyer,
    mint,
    bondingCurveCreator,
    solAmount,
    slippageBasisPoints,
    priorityFees,
    commitment = util_1.DEFAULT_COMMITMENT
  ) {
    const transaction = await this.getBuyInstructionsBySolAmount(
      buyer,
      mint,
      solAmount,
      slippageBasisPoints,
      commitment,
    );
    return await (0, util_1.returnTx)(transaction, priorityFees);
  }
  //sell
  async getSellInstructionsByTokenAmount(
    seller,
    mint,
    sellTokenAmount,
    slippageBasisPoints = 500n,
    commitment = util_1.DEFAULT_COMMITMENT
  ) {
    let bondingCurveAccount = await this.getBondingCurveAccount(
      mint,
      commitment
    );
    if (!bondingCurveAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }
    let globalAccount = await this.getGlobalAccount(commitment);
    let minSolOutput = bondingCurveAccount.getSellPrice(
      sellTokenAmount,
      globalAccount.feeBasisPoints
    );
    let sellAmountWithSlippage = (0, util_1.calculateWithSlippageSell)(
      minSolOutput,
      slippageBasisPoints
    );
    return await this.getSellInstructions(
      seller,
      mint,
      globalAccount.feeRecipient,
      sellTokenAmount,
      sellAmountWithSlippage
    );
  }
  async getSellInstructions(seller, mint, feeRecipient, amount, minSolOutput) {
    const mintInfo = await this.connection.getAccountInfo(mint, "confirmed");
    if (!mintInfo) {
      throw new Error(`Mint account not found: ${mint.toBase58()}`);
    }
    const tokenProgram = mintInfo.owner.equals(
      spl_token_1.TOKEN_2022_PROGRAM_ID
    )
      ? spl_token_1.TOKEN_2022_PROGRAM_ID
      : spl_token_1.TOKEN_PROGRAM_ID;
    const bondingCurve = this.getBondingCurvePDA(mint);
    const associatedBondingCurve = (0,
    spl_token_1.getAssociatedTokenAddressSync)(
      mint,
      bondingCurve,
      true,
      tokenProgram
    );
    const associatedUser = await (0, spl_token_1.getAssociatedTokenAddress)(
      mint,
      seller,
      false,
      tokenProgram
    );
    const [global] = web3_js_1.PublicKey.findProgramAddressSync(
      [Buffer.from(exports.GLOBAL_ACCOUNT_SEED)],
      PUMP_PROGRAM_ID
    );
    const bondingCurveAccount = await this.getBondingCurveAccount(
      mint,
      "confirmed"
    );
    if (!bondingCurveAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }
    const creatorVault = this.getCreatorVaultPDA(bondingCurveAccount.creator);
    // The deployed Pump.fun sell instruction treats the accounts after
    // `fee_program` as remaining accounts. The first remaining account must
    // be the V2 bonding-curve PDA; the legacy extra account is rejected with
    // InvalidBondingCurveV2 (6074).
    const bondingCurveV2 = web3_js_1.PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve-v2"), mint.toBuffer()],
      PUMP_PROGRAM_ID,
    )[0];
    const key = (pubkey, isWritable = false, isSigner = false) => ({
      pubkey,
      isWritable,
      isSigner,
    });
    const data = Buffer.alloc(24);
    PUMPFUN_SELL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amount.toString()), 8);
    data.writeBigUInt64LE(BigInt(minSolOutput.toString()), 16);
    const transaction = new web3_js_1.Transaction();
    transaction.add(
      new web3_js_1.TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        data,
        keys: [
          key(global),
          key(feeRecipient, true),
          key(mint),
          key(bondingCurve, true),
          key(associatedBondingCurve, true),
          key(associatedUser, true),
          key(seller, true, true),
          key(web3_js_1.SystemProgram.programId),
          key(creatorVault, true),
          key(tokenProgram),
          key(PUMPFUN_EVENT_AUTHORITY),
          key(PUMP_PROGRAM_ID),
          key(PUMPFUN_FEE_CONFIG, true),
          key(PUMPFUN_FEE_PROGRAM, true),
          key(bondingCurveV2),
          key(PUMPFUN_BUYBACK_ACCOUNT, true),
        ],
      })
    );
    return transaction;
  }
  async getBondingCurveAccount(mint, commitment = util_1.DEFAULT_COMMITMENT) {
    const tokenAccount = await this.connection.getAccountInfo(
      this.getBondingCurvePDA(mint),
      commitment
    );
    if (!tokenAccount) {
      return null;
    }
    return bondingCurveAccount_1.BondingCurveAccount.fromBuffer(
      tokenAccount.data
    );
  }
  async getGlobalAccount(commitment = util_1.DEFAULT_COMMITMENT) {
    const [globalAccountPDA] = web3_js_1.PublicKey.findProgramAddressSync(
      [Buffer.from(exports.GLOBAL_ACCOUNT_SEED)],
      new web3_js_1.PublicKey(PROGRAM_ID)
    );
    const tokenAccount = await this.connection.getAccountInfo(
      globalAccountPDA,
      commitment
    );
    return globalAccount_1.GlobalAccount.fromBuffer(tokenAccount.data);
  }
  getBondingCurvePDA(mint) {
    return web3_js_1.PublicKey.findProgramAddressSync(
      [Buffer.from(exports.BONDING_CURVE_SEED), mint.toBuffer()],
      this.program.programId
    )[0];
  }
  getCreatorVaultPDA(creator) {
    return web3_js_1.PublicKey.findProgramAddressSync(
      [Buffer.from(exports.CREATOR_VAULT_SEED), creator.toBuffer()],
      this.program.programId
    )[0];
  }
  async createTokenMetadata(create) {
    // Validate file
    if (!(create.file instanceof Blob)) {
      throw new Error("File must be a Blob or File object");
    }
    let formData = new FormData();
    formData.append("file", create.file, "image.png"); // Add filename
    formData.append("name", create.name);
    formData.append("symbol", create.symbol);
    formData.append("description", create.description);
    formData.append("twitter", create.twitter || "");
    formData.append("telegram", create.telegram || "");
    formData.append("website", create.website || "");
    formData.append("showName", "true");
    try {
      const request = await fetch("https://pump.fun/api/ipfs", {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
        body: formData,
        credentials: "same-origin",
      });
      if (request.status === 500) {
        // Try to get more error details
        const errorText = await request.text();
        throw new Error(
          `Server error (500): ${errorText || "No error details available"}`
        );
      }
      if (!request.ok) {
        throw new Error(`HTTP error! status: ${request.status}`);
      }
      const responseText = await request.text();
      if (!responseText) {
        throw new Error("Empty response received from server");
      }
      try {
        return JSON.parse(responseText);
      } catch (e) {
        throw new Error(`Invalid JSON response: ${responseText}`);
      }
    } catch (error) {
      console.error("Error in createTokenMetadata:", error);
      throw error;
    }
  }
  //EVENTS
  addEventListener(eventType, callback) {
    return this.program.addEventListener(
      eventType,
      (event, slot, signature) => {
        let processedEvent;
        switch (eventType) {
          case "createEvent":
            processedEvent = (0, events_1.toCreateEvent)(event);
            callback(processedEvent, slot, signature);
            break;
          case "tradeEvent":
            processedEvent = (0, events_1.toTradeEvent)(event);
            callback(processedEvent, slot, signature);
            break;
          case "completeEvent":
            processedEvent = (0, events_1.toCompleteEvent)(event);
            callback(processedEvent, slot, signature);
            console.log("completeEvent", event, slot, signature);
            break;
          case "setParamsEvent":
            processedEvent = (0, events_1.toSetParamsEvent)(event);
            callback(processedEvent, slot, signature);
            break;
          default:
            console.error("Unhandled event type:", eventType);
        }
      }
    );
  }
  removeEventListener(eventId) {
    this.program.removeEventListener(eventId);
  }
}
exports.PumpFunSDK = PumpFunSDK;
