"use strict";

const { Service } = require("egg");
const { Keypair, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");
const fs = require("fs");
const { connection } = require("../constants");
const { transferAllSol } = require("../utils/solana");

const ACTIVE_BOSS_INDEX = "one_active_boss_per_line";

class BossLifecycle extends Service {
  writeKeypair(candidate) {
    try {
      fs.writeFileSync("keypair.json", JSON.stringify({
        bossAddress: candidate.bossAddress,
        privateKey: candidate.privateKey,
      }));
    } catch (error) {
      // MongoDB already holds the keypair; a file export error must not trigger another rotation.
      this.ctx.logger.error("Boss keypair file export failed; keypair remains in MongoDB", error);
    }
  }

  minimumBalance() {
    const amount = Number(process.env.BOSS_ACTIVATION_MIN_LAMPORTS || 10000);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error("BOSS_ACTIVATION_MIN_LAMPORTS must be a positive integer");
    }
    return amount;
  }

  async prepareStorage() {
    const model = this.ctx.model.ExecuteData;
    const hello = await model.db.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") {
      throw new Error("Boss activation requires a MongoDB replica set or mongos; no SOL was transferred");
    }
    // Fail before sending funds if existing duplicate active records prevent the index.
    await model.collection.createIndex(
      { line: 1 },
      {
        name: ACTIVE_BOSS_INDEX,
        unique: true,
        partialFilterExpression: { active: true },
      },
    );
  }

  async findPending(line, current) {
    const legacy = {
      bossStatus: { $exists: false },
      transferSignature: { $exists: true },
    };
    if (current) legacy.eid = { $gt: current.eid };
    else {
      const latest = await this.ctx.model.ExecuteData.findOne({ line })
        .sort({ eid: -1 }).select("_id").lean();
      if (latest) legacy._id = latest._id;
    }
    return this.ctx.model.ExecuteData.findOne({
      line,
      active: false,
      $or: [{ bossStatus: { $in: ["pending", "awaiting_funds"] } }, legacy],
    }).select("+transferTransaction").read("primary").sort({ eid: -1 }).lean();
  }

  async assertNoPending(line) {
    const current = await this.ctx.service.executeSwap.getExecuteData(line);
    const pending = await this.findPending(line, current);
    if (pending) {
      throw new Error(`Boss ${pending.bossAddress} is pending; call start to reconcile before moving funds`);
    }
  }

  isFinalized(status) {
    return status && (status.confirmationStatus === "finalized" || status.confirmations === null);
  }

  async activate(candidate, previous, assertLock, minContextSlot) {
    const { ctx } = this;
    await assertLock();
    const balance = await connection.getBalanceAndContext(
      new PublicKey(candidate.bossAddress),
      { commitment: "finalized", ...(minContextSlot == null ? {} : { minContextSlot }) },
    );
    if (balance.value < this.minimumBalance()) {
      throw new Error(`Boss ${candidate.bossAddress} is awaiting funds: needs at least ${this.minimumBalance()} lamports, found ${balance.value}; active was not changed`);
    }

    const session = await ctx.model.ExecuteData.db.startSession();
    try {
      // Commit retirement first: the unique active-line key must be released
      // before assigning it to another document. A crash leaves a recoverable
      // pending destination, never two active bosses or a newly active empty one.
      await session.withTransaction(async () => {
        // A write to the lease fences concurrent database activation after lease loss.
        await assertLock(session);
        const active = await ctx.model.ExecuteData.findOne({ line: candidate.line, active: true })
          .session(session).lean();
        if (active && String(active._id) !== String(previous?._id)) {
          throw new Error("Active boss changed before activation; reconcile before retrying");
        }
        if (active) {
          await ctx.model.ExecuteData.updateOne(
            { _id: active._id, active: true },
            { $set: { active: false, bossStatus: "retired" } },
            { session },
          );
        }
        const pending = await ctx.model.ExecuteData.exists({ _id: candidate._id, active: false })
          .session(session);
        if (!pending) throw new Error("Pending boss no longer exists");
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });

      await session.withTransaction(async () => {
        await assertLock(session);
        const active = await ctx.model.ExecuteData.exists({ line: candidate.line, active: true })
          .session(session);
        if (active) throw new Error("An active boss already exists; reconcile before retrying");
        const result = await ctx.model.ExecuteData.updateOne(
          { _id: candidate._id, active: false },
          {
            $set: {
              active: true,
              bossStatus: "active",
              activatedAt: new Date(),
              activationBalanceLamports: balance.value,
              activationSlot: balance.context.slot,
            },
          },
          { session },
        );
        if (result.matchedCount !== 1) throw new Error("Pending boss could not be activated");
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally {
      await session.endSession();
    }

    await this.verifyActive(candidate, assertLock, balance.context.slot);
    this.writeKeypair(candidate);
    return true;
  }

  async verifyActive(candidate, assertLock, minContextSlot) {
    await assertLock();
    const active = await this.ctx.service.executeSwap.getExecuteData(candidate.line);
    if (!active || String(active._id) !== String(candidate._id)) {
      throw new Error("Boss activation could not be verified");
    }
    const { value } = await connection.getBalanceAndContext(
      new PublicKey(candidate.bossAddress),
      { commitment: "finalized", ...(minContextSlot == null ? {} : { minContextSlot }) },
    );
    if (value < this.minimumBalance()) {
      throw new Error(`Active boss balance is below ${this.minimumBalance()} lamports; new boss did not complete successfully`);
    }
  }

  async recover(line, current, assertLock) {
    const pending = await this.findPending(line, current);
    if (!pending) return false;
    await assertLock();
    if (!pending.transferSignature) {
      // A crash before preparing a transfer must reuse the saved keypair.
      if (pending.bossStatus === "pending") {
        if (!current) throw new Error(`Pending boss ${pending.bossAddress} has no source boss; manual reconciliation required`);
        return this.fund(pending, current, assertLock);
      }
      return this.activate(pending, current, assertLock);
    }

    const { value } = await connection.getSignatureStatuses(
      [pending.transferSignature], { searchTransactionHistory: true },
    );
    const status = value?.[0];
    if (this.isFinalized(status)) {
      if (!status.err) return this.activate(pending, current, assertLock, status.slot);
      await this.markFailed(pending, assertLock);
      return false;
    }
    if (!status) {
      const head = await connection.getEpochInfo({ commitment: "finalized" });
      if (pending.transferLastValidBlockHeight != null && head.blockHeight > pending.transferLastValidBlockHeight) {
        const balance = await connection.getBalanceAndContext(
          new PublicKey(pending.bossAddress),
          { commitment: "finalized", minContextSlot: head.absoluteSlot },
        );
        if (balance.value > 0) {
          throw new Error(`Boss ${pending.bossAddress} has funds but transaction history is unavailable; retaining pending record for reconciliation`);
        }
        // Expiry plus a zero balance at a finalized post-expiry slot permits a new attempt.
        await this.markFailed(pending, assertLock);
        return false;
      }
      if (pending.transferTransaction) {
        await assertLock();
        try {
          const signature = await connection.sendRawTransaction(
            Buffer.from(pending.transferTransaction, "base64"),
            { skipPreflight: false, maxRetries: 0 },
          );
          if (signature !== pending.transferSignature) throw new Error("Unexpected transfer signature");
        } catch (error) {
          this.ctx.logger.warn(`Boss transfer rebroadcast unresolved: ${pending.transferSignature} (${error.code || error.name})`);
        }
      }
    }
    throw new Error(`Boss transfer ${pending.transferSignature} is pending finalization; retry start to reconcile the same transaction`);
  }

  async markFailed(candidate, assertLock) {
    await assertLock();
    await this.ctx.model.ExecuteData.updateOne(
      { _id: candidate._id, active: false },
      { $set: { bossStatus: "failed" } },
      { writeConcern: { w: "majority" } },
    );
    // Keep the address/key/signature for reconciliation; never delete a funded keypair.
  }

  async fund(candidate, previous, assertLock) {
    if (candidate.previousExecuteDataId && String(candidate.previousExecuteDataId) !== String(previous._id)) {
      throw new Error("Pending boss source changed; manual reconciliation required");
    }
    const source = Keypair.fromSecretKey(bs58.decode(previous.privateKey));
    if (source.publicKey.toBase58() !== previous.bossAddress) {
      throw new Error("Source boss private key does not match its address");
    }
    const transferred = await transferAllSol(
      connection, source, new PublicKey(candidate.bossAddress), 0,
      async (transfer) => {
        await assertLock();
        const saved = await this.ctx.model.ExecuteData.updateOne(
          { _id: candidate._id, active: false, transferSignature: { $exists: false } },
          {
            $set: {
              transferSignature: transfer.signature,
              transferBlockhash: transfer.blockhash,
              transferLastValidBlockHeight: transfer.lastValidBlockHeight,
              transferTransaction: transfer.transaction,
            },
          },
          { writeConcern: { w: "majority" } },
        );
        if (saved.matchedCount !== 1) throw new Error("Could not persist boss transfer before broadcast");
        await assertLock();
      },
      { commitment: "finalized", minimumTransferLamports: this.minimumBalance(), confirmationTimeoutMs: 20000 },
    );
    if (!transferred) {
      // No transaction was prepared or submitted. Do not activate an empty destination.
      await this.markFailed(candidate, assertLock);
      throw new Error("Boss balance is insufficient after fees; new boss was not activated");
    }
    return this.recover(candidate.line, previous, assertLock);
  }

  async create(line, previous, assertLock) {
    await assertLock();
    if (previous) {
      const balance = await connection.getBalance(new PublicKey(previous.bossAddress), "finalized");
      if (balance < this.minimumBalance() + 5000) {
        throw new Error(`Boss balance must cover ${this.minimumBalance()} lamports plus transfer fees; no new boss was created`);
      }
    }
    const boss = Keypair.generate();
    const eid = await this.ctx.service.executeSwap.getNextEid();
    const payload = {
      eid,
      bossAddress: boss.publicKey.toBase58(),
      privateKey: bs58.encode(boss.secretKey),
      line,
      active: false,
      bossStatus: previous ? "pending" : "awaiting_funds",
      previousExecuteDataId: previous?._id,
      createTime: new Date(),
    };
    let candidate;
    const session = await this.ctx.model.ExecuteData.db.startSession();
    try {
      await session.withTransaction(async () => {
        await assertLock(session);
        [candidate] = await this.ctx.model.ExecuteData.create([payload], { session });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally {
      await session.endSession();
    }
    this.writeKeypair(candidate);
    if (!previous) {
      throw new Error(`Boss ${candidate.bossAddress} created awaiting funds; deposit at least ${this.minimumBalance()} lamports then call start again`);
    }
    return this.fund(candidate, previous, assertLock);
  }

  async generate(line, times = 1, checkWallets = false, recoverOnly = false) {
    const count = Number(times);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("times must be a positive integer");
    this.minimumBalance();
    return this.ctx.service.executeSwap.withBossGenerationLock(line, async (assertLock) => {
      await this.prepareStorage();
      for (let index = 0; index < count; index++) {
        const current = await this.ctx.service.executeSwap.getExecuteData(line);
        // Recovery counts as completing the previously interrupted generation.
        if (await this.recover(line, current, assertLock)) continue;
        if (recoverOnly) return false;
        if (checkWallets && current) {
          const wallets = await this.ctx.service.executeSwap.getWallets(line);
          for (const wallet of wallets) {
            if (await connection.getBalance(wallet.publicKey, "finalized") > 0) {
              throw new Error("Wallet has balance");
            }
          }
        }
        if (await this.create(line, current, assertLock) !== true) {
          throw new Error("Boss generation did not complete; reconcile before retrying");
        }
      }
      const active = await this.ctx.service.executeSwap.getExecuteData(line);
      if (!active) throw new Error("No active funded boss after generation");
      await this.verifyActive(active, assertLock, active.activationSlot);
      return true;
    });
  }
}

module.exports = BossLifecycle;
