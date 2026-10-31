"use strict";

const { Service } = require("egg");
const { Keypair, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");
const fs = require("fs");
const { connection } = require("../constants");
const { transferAllSol } = require("../utils/solana");

const ACTIVE_BOSS_INDEX = "one_active_boss_per_line";
const PENDING_BOSS_INDEX = "one_pending_boss_per_line";
const DURABLE_WRITE = { writeConcern: { w: 1, j: true } };

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
    // Fail before sending funds if existing duplicate active records prevent the index.
    await model.collection.createIndex(
      { line: 1 },
      {
        name: ACTIVE_BOSS_INDEX,
        unique: true,
        partialFilterExpression: { active: true },
      },
    );
    await model.collection.createIndex(
      { line: 1, bossPending: 1 },
      {
        name: PENDING_BOSS_INDEX,
        unique: true,
        partialFilterExpression: { bossPending: true },
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
      $or: [
        { bossPending: true },
        { bossStatus: { $in: ["pending", "awaiting_funds"] } },
        legacy,
      ],
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

  pendingError(candidate, message) {
    const error = new Error(message);
    error.code = "BOSS_RECOVERY_PENDING";
    error.bossAddress = candidate.bossAddress;
    return error;
  }

  async activate(candidate, previous, assertLock, minContextSlot) {
    const { ctx } = this;
    await assertLock();
    const balance = await connection.getBalanceAndContext(
      new PublicKey(candidate.bossAddress),
      { commitment: "finalized", ...(minContextSlot == null ? {} : { minContextSlot }) },
    );
    if (balance.value < this.minimumBalance()) {
      throw this.pendingError(candidate, `Boss ${candidate.bossAddress} is awaiting finalized funds: needs at least ${this.minimumBalance()} lamports, found ${balance.value}; automatic reconciliation will retry`);
    }

    // Single-document conditional writes also work on MongoDB standalone.
    // The pending marker remains until activation, so a crash between writes
    // leaves a saved destination for the next request to recover.
    await assertLock();
    const pending = await ctx.model.ExecuteData.exists({
      _id: candidate._id, active: false, bossPending: true,
    });
    if (!pending) throw new Error("Pending boss no longer exists");
    const active = await ctx.service.executeSwap.getExecuteData(candidate.line);
    if (active && String(active._id) !== String(previous?._id)) {
      throw new Error("Active boss changed before activation; reconcile before retrying");
    }
    if (active && candidate.previousExecuteDataId && String(active._id) !== String(candidate.previousExecuteDataId)) {
      throw new Error("Pending boss does not belong to the active source; manual reconciliation required");
    }
    if (active) {
      await assertLock();
      const retired = await ctx.model.ExecuteData.updateOne(
        { _id: active._id, active: true },
        { $set: { active: false, bossStatus: "retired" } },
        DURABLE_WRITE,
      );
      if (retired.matchedCount !== 1) throw new Error("Source boss changed before retirement");
    }
    await assertLock();
    if (await ctx.model.ExecuteData.exists({ line: candidate.line, active: true })) {
      throw new Error("An active boss already exists; reconcile before retrying");
    }
    const result = await ctx.model.ExecuteData.updateOne(
      { _id: candidate._id, active: false, bossPending: true },
      {
        $set: {
          active: true,
          bossStatus: "active",
          bossPending: false,
          activatedAt: new Date(),
          activationBalanceLamports: balance.value,
          activationSlot: balance.context.slot,
        },
      },
      DURABLE_WRITE,
    );
    if (result.matchedCount !== 1) throw new Error("Pending boss could not be activated");

    await this.verifyActive(candidate, assertLock, balance.context.slot);
    this.writeKeypair(candidate);
    ctx.logger.info(`Boss activated: line=${candidate.line}, address=${candidate.bossAddress}, balanceLamports=${balance.value}, slot=${balance.context.slot}`);
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

  async repairActive(line) {
    const { ctx } = this;
    return ctx.service.executeSwap.withBossGenerationLock(line, async (assertLock) => {
      const lineId = Number(line);
      await this.prepareStorage();
      const candidate = await ctx.model.ExecuteData.findOne({ line: lineId })
        .sort({ eid: -1, _id: -1 }).read("primary").lean();
      if (!candidate) throw new Error(`No ExecuteData exists for line ${lineId}`);
      const current = await ctx.service.executeSwap.getExecuteData(lineId);
      const result = (repaired, balance) => ({
        repaired,
        line: lineId,
        eid: Number(candidate.eid),
        address: candidate.bossAddress,
        active: true,
        bossStatus: "active",
        balanceLamports: balance.value,
        balance: balance.value / 1e9,
        minimumBalanceLamports: this.minimumBalance(),
        slot: balance.context.slot,
        previousAddress: current && String(current._id) !== String(candidate._id)
          ? current.bossAddress : null,
      });
      if (["failed", "retired"].includes(candidate.bossStatus)) {
        throw new Error(`Latest boss ${candidate.bossAddress} is ${candidate.bossStatus}; repair refused`);
      }
      if (candidate.active !== true && candidate.active !== false) {
        throw new Error("Latest boss has an invalid active state; repair refused");
      }
      if (candidate.active === false && ![undefined, null, "pending", "awaiting_funds", "active"].includes(candidate.bossStatus)) {
        throw new Error("Latest boss is not in a repairable state");
      }
      // Validate the stored key before retiring the source. Never expose it.
      const keypair = Keypair.fromSecretKey(bs58.decode(candidate.privateKey));
      if (keypair.publicKey.toBase58() !== candidate.bossAddress) {
        throw new Error("Latest boss private key does not match its address; repair refused");
      }
      const balance = await connection.getBalanceAndContext(
        new PublicKey(candidate.bossAddress), { commitment: "finalized" },
      );
      if (balance.value < this.minimumBalance()) {
        throw new Error(`Latest boss ${candidate.bossAddress} needs at least ${this.minimumBalance()} finalized lamports, found ${balance.value}; no active state was changed`);
      }
      await assertLock();
      if (candidate.active === true && candidate.bossStatus === "active" && candidate.bossPending === false) {
        await this.verifyActive(candidate, assertLock, balance.context.slot);
        return result(false, balance);
      }
      const otherPending = await ctx.model.ExecuteData.exists({
        line: lineId, _id: { $ne: candidate._id },
        $or: [{ bossPending: true }, { bossStatus: { $in: ["pending", "awaiting_funds"] } }],
      });
      if (otherPending) throw new Error("Another pending boss exists for this line; repair refused");
      const latest = await ctx.model.ExecuteData.findOne({ line: lineId })
        .sort({ eid: -1, _id: -1 }).select("_id").read("primary").lean();
      if (String(latest?._id) !== String(candidate._id)) {
        throw new Error("Latest boss changed during repair; retry repairBoss");
      }
      await assertLock();
      if (candidate.active === true) {
        const updated = await ctx.model.ExecuteData.updateOne(
          { _id: candidate._id, line: lineId, active: true, bossStatus: { $nin: ["failed", "retired"] } },
          { $set: { bossStatus: "active", bossPending: false } },
          DURABLE_WRITE,
        );
        if (updated.matchedCount !== 1) throw new Error("Latest boss changed during repair");
        await this.verifyActive(candidate, assertLock, balance.context.slot);
      } else {
        if (current && candidate.previousExecuteDataId && String(current._id) !== String(candidate.previousExecuteDataId)) {
          throw new Error("Latest boss does not belong to the active source; repair refused");
        }
        const adopted = await ctx.model.ExecuteData.updateOne(
          { _id: candidate._id, line: lineId, active: false, bossStatus: { $nin: ["failed", "retired"] } },
          { $set: { bossPending: true, bossStatus: "pending" } },
          DURABLE_WRITE,
        );
        if (adopted.matchedCount !== 1) throw new Error("Latest boss changed during repair");
        // Uses conditional writes and the active unique index on standalone.
        // If activation fails after retirement, this pending record is retryable.
        await this.activate(candidate, current, assertLock, balance.context.slot);
      }
      ctx.logger.info(`Boss state repaired: line=${lineId}, address=${candidate.bossAddress}, previousAddress=${current?.bossAddress || "none"}`);
      return result(true, balance);
    });
  }

  async recover(line, current, assertLock, { allowFunding = true } = {}) {
    const pending = await this.findPending(line, current);
    if (!pending) return false;
    await assertLock();
    // Adopt records created before the pending-line uniqueness guard existed.
    const adopted = await this.ctx.model.ExecuteData.updateOne(
      { _id: pending._id, active: false, bossStatus: { $nin: ["failed", "retired", "active"] } },
      { $set: { bossPending: true } },
      DURABLE_WRITE,
    );
    if (adopted.matchedCount !== 1) throw new Error("Pending boss changed; reconcile before retrying");
    if (!pending.transferSignature) {
      // A crash before preparing a transfer must reuse the saved keypair.
      if (pending.bossStatus === "pending") {
        const balance = await connection.getBalanceAndContext(
          new PublicKey(pending.bossAddress), { commitment: "finalized" },
        );
        if (balance.value >= this.minimumBalance()) {
          return this.activate(pending, current, assertLock, balance.context.slot);
        }
        if (!allowFunding) return false;
        if (!current) throw new Error(`Pending boss ${pending.bossAddress} has no source boss; manual reconciliation required`);
        return this.fund(pending, current, assertLock);
      }
      return this.activate(pending, current, assertLock);
    }

    let status;
    try {
      const { value } = await connection.getSignatureStatuses(
        [pending.transferSignature], { searchTransactionHistory: true },
      );
      status = value?.[0];
    } catch (error) {
      // Some RPC providers cannot serve history. The finalized balance can
      // still establish that the saved destination is funded.
      this.ctx.logger.warn(`Boss transfer history unavailable: line=${line}, address=${pending.bossAddress}, signature=${pending.transferSignature}`);
    }
    if (this.isFinalized(status)) {
      if (!status.err) return this.activate(pending, current, assertLock, status.slot);
      await this.markFailed(pending, assertLock);
      return false;
    }
    if (!status) {
      const head = await connection.getEpochInfo({ commitment: "finalized" });
      const balance = await connection.getBalanceAndContext(
        new PublicKey(pending.bossAddress),
        { commitment: "finalized", minContextSlot: head.absoluteSlot },
      );
      // Activation requires a funded destination, even when history was pruned
      // or legacy records lack an expiry height. Expiry is required only to
      // abandon an empty destination and permit a newly signed transaction.
      if (balance.value >= this.minimumBalance()) {
        return this.activate(pending, current, assertLock, balance.context.slot);
      }
      if (pending.transferLastValidBlockHeight != null && head.blockHeight > pending.transferLastValidBlockHeight) {
        if (balance.value > 0) {
          throw this.pendingError(pending, `Boss ${pending.bossAddress} has finalized funds below the activation minimum; retaining pending record`);
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
    throw this.pendingError(pending, `Boss transfer ${pending.transferSignature} is pending finalization; automatic reconciliation will retry the saved destination`);
  }

  async reconcilePending() {
    const { ctx } = this;
    const lines = await ctx.model.ExecuteData.distinct("line", {
      active: false,
      $or: [
        { bossPending: true },
        { bossStatus: { $in: ["pending", "awaiting_funds"] } },
        { bossStatus: { $exists: false }, transferSignature: { $exists: true } },
      ],
    });
    for (const line of lines) {
      if (!Number.isSafeInteger(line) || line < 1) continue;
      try {
        await ctx.service.executeSwap.withBossGenerationLock(line, async (assertLock) => {
          await this.prepareStorage();
          const current = await ctx.service.executeSwap.getExecuteData(line);
          // Only recover saved work. Never create a boss or sign another transfer.
          if (await this.recover(line, current, assertLock, { allowFunding: false })) {
            ctx.logger.info(`Pending boss activated by reconciliation: line=${line}`);
          }
        });
      } catch (error) {
        if (["BOSS_RECOVERY_PENDING", "LINE_OPERATION_LOCKED"].includes(error.code)) continue;
        ctx.logger.error(`Boss reconciliation failed: line=${line}`, error);
      }
    }
  }

  async markFailed(candidate, assertLock) {
    await assertLock();
    await this.ctx.model.ExecuteData.updateOne(
      { _id: candidate._id, active: false, bossPending: true },
      { $set: { bossStatus: "failed", bossPending: false } },
      DURABLE_WRITE,
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
    let transferred;
    try {
      transferred = await transferAllSol(
        connection, source, new PublicKey(candidate.bossAddress), 0,
        async (transfer) => {
          await assertLock();
          const saved = await this.ctx.model.ExecuteData.updateOne(
            { _id: candidate._id, active: false, bossPending: true, transferSignature: { $exists: false } },
            {
              $set: {
                transferSignature: transfer.signature,
                transferBlockhash: transfer.blockhash,
                transferLastValidBlockHeight: transfer.lastValidBlockHeight,
                transferTransaction: transfer.transaction,
              },
            },
            DURABLE_WRITE,
          );
          if (saved.matchedCount !== 1) throw new Error("Could not persist boss transfer before broadcast");
          await assertLock();
        },
        { commitment: "finalized", minimumTransferLamports: this.minimumBalance(), confirmationTimeoutMs: 20000 },
      );
    } catch (error) {
      // The transaction may have landed after the confirmation deadline.
      // Reconcile now as well as in the scheduled recovery worker.
      const saved = await this.ctx.model.ExecuteData.exists({
        _id: candidate._id, active: false, bossPending: true,
        transferSignature: { $exists: true },
      });
      if (!saved) throw error;
      this.ctx.logger.warn(`Boss transfer needs reconciliation: line=${candidate.line}, address=${candidate.bossAddress}, reason=${error.code || error.name}`);
      return this.recover(candidate.line, previous, assertLock, { allowFunding: false });
    }
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
      bossPending: true,
      bossStatus: previous ? "pending" : "awaiting_funds",
      previousExecuteDataId: previous?._id,
      createTime: new Date(),
    };
    await assertLock();
    const [candidate] = await this.ctx.model.ExecuteData.create([payload], DURABLE_WRITE);
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
