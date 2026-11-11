const { strict: assert } = require('node:assert');
const { PublicKey } = require('@solana/web3.js');

const BossLifecycle = require('../../../app/service/bossLifecycle');

const ADDRESS = '4VrAnsCZ1yuvP7563WEHiGV6AEPxQB8JyxfQtQNSeamf';

describe('bossLifecycle.readBalance', () => {
  it('uses the guarded read when the RPC node is caught up', async () => {
    const calls = [];
    const service = createService(async (method, publicKey, config) => {
      calls.push(config);
      return balance(1000, 500);
    });

    const result = await service.readBalance(ADDRESS, 500);

    assert.equal(result.value, 1000);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].minContextSlot, 500);
    assert.equal(calls[0].commitment, 'finalized');
  });

  it('retries when a load-balanced node is behind the observed slot', async () => {
    let attempts = 0;
    const service = createService(async () => {
      attempts += 1;
      if (attempts < 3) throw minContextSlotError();
      return balance(2000, 640);
    });

    const result = await service.readBalance(ADDRESS, 640);

    assert.equal(result.value, 2000);
    assert.equal(attempts, 3);
  });

  it('falls back to an unguarded read and keeps the slot guarantee locally', async () => {
    const calls = [];
    const service = createService(async (method, publicKey, config) => {
      calls.push(config);
      if (config.minContextSlot != null) throw minContextSlotError();
      return balance(3000, 700);
    });

    const result = await service.readBalance(ADDRESS, 700);

    assert.equal(result.value, 3000);
    assert.equal(calls.length, 4);
    assert.equal(calls.at(-1).minContextSlot, undefined);
    assert.deepEqual(Object.keys(calls.at(-1)), ['commitment']);
  });

  it('fails with a retryable code when the node never reaches the required slot', async () => {
    const service = createService(async (method, publicKey, config) => {
      if (config.minContextSlot != null) throw minContextSlotError();
      return balance(4000, 690);
    });

    await assert.rejects(
      () => service.readBalance(ADDRESS, 700),
      (error) => {
        assert.equal(error.code, 'BOSS_RPC_SLOT_LAG');
        assert.match(error.message, /10 slot\(s\) behind required slot 700/);
        return true;
      },
    );
  });

  it('accepts a lagging fallback read when the caller is not strict', async () => {
    const service = createService(async (method, publicKey, config) => {
      if (config.minContextSlot != null) throw minContextSlotError();
      return balance(5000, 690);
    });

    const result = await service.readBalance(ADDRESS, 700, { strict: false });

    assert.equal(result.value, 5000);
    assert.equal(result.context.slot, 690);
  });

  it('does not swallow unrelated RPC failures', async () => {
    let attempts = 0;
    const service = createService(async () => {
      attempts += 1;
      const timeout = new Error('Boss RPC getBalanceAndContext timed out after 5000ms; pending state retained');
      timeout.code = 'BOSS_RPC_TIMEOUT';
      throw timeout;
    });

    await assert.rejects(
      () => service.readBalance(ADDRESS, 700),
      (error) => error.code === 'BOSS_RPC_TIMEOUT',
    );
    assert.equal(attempts, 1);
  });
});

function createService(rpc) {
  const warnings = [];
  const service = new BossLifecycle({
    logger: {
      warn: (message) => warnings.push(message),
      info: () => {},
      error: () => {},
    },
    app: {},
    config: {},
  });
  service.rpcWithTimeout = rpc;
  // Retry delays only exist to let real nodes catch up.
  service.sleep = async () => {};
  service.warnings = warnings;
  return service;
}

describe('bossLifecycle placeholder recovery', () => {
  const originalGrace = process.env.BOSS_PLACEHOLDER_GRACE_MS;

  afterEach(() => {
    if (originalGrace == null) delete process.env.BOSS_PLACEHOLDER_GRACE_MS;
    else process.env.BOSS_PLACEHOLDER_GRACE_MS = originalGrace;
  });

  it('treats a never-funded record older than the grace window as abandonable', () => {
    process.env.BOSS_PLACEHOLDER_GRACE_MS = '600000';
    const service = createService();
    const pending = placeholder({ createdMinutesAgo: 30 });

    assert.equal(service.isAbandonablePlaceholder(pending, ACTIVE_BOSS), true);
  });

  it('keeps an unfunded placeholder inside the grace window', () => {
    process.env.BOSS_PLACEHOLDER_GRACE_MS = '600000';
    const service = createService();
    const pending = placeholder({ createdMinutesAgo: 1 });

    assert.equal(service.isAbandonablePlaceholder(pending, ACTIVE_BOSS), false);
  });

  it('never abandons a placeholder when the line has no active boss', () => {
    process.env.BOSS_PLACEHOLDER_GRACE_MS = '0';
    const service = createService();

    assert.equal(service.isAbandonablePlaceholder(placeholder({ createdMinutesAgo: 30 }), null), false);
  });

  it('never abandons a record that already saved a transfer', () => {
    process.env.BOSS_PLACEHOLDER_GRACE_MS = '0';
    const service = createService();
    const pending = placeholder({ createdMinutesAgo: 30, transferSignature: 'sig' });

    assert.equal(service.isAbandonablePlaceholder(pending, ACTIVE_BOSS), false);
  });

  it('reports the deposit requirement while no active boss can fund a placeholder', async () => {
    process.env.BOSS_PLACEHOLDER_GRACE_MS = '0';
    const service = createService(async () => balance(0, 900));
    const pending = placeholder({ createdMinutesAgo: 30 });
    stubRecovery(service, pending);

    await assert.rejects(
      () => service.recover(10003, null, async () => {}),
      (error) => {
        assert.equal(error.code, 'BOSS_RECOVERY_PENDING');
        assert.match(error.message, /send at least 10000 lamports/);
        assert.match(error.message, /no funded active boss/);
        return true;
      },
    );
  });

  it('abandons the placeholder so a funded active boss can seed a new one', async () => {
    process.env.BOSS_PLACEHOLDER_GRACE_MS = '0';
    const service = createService(async () => balance(0, 900));
    const pending = placeholder({ createdMinutesAgo: 30 });
    const updates = [];
    stubRecovery(service, pending, updates);

    const recovered = await service.recover(10003, ACTIVE_BOSS, async () => {});

    assert.equal(recovered, false);
    const failed = updates.filter((update) => update.$set.bossStatus === 'failed');
    assert.equal(failed.length, 1);
    assert.deepEqual(failed[0].$set, { bossStatus: 'failed', bossPending: false });
    assert.match(service.warnings.join('\n'), /placeholder boss abandoned/);
  });
});

const ACTIVE_BOSS = { _id: 'active-id', line: 10003, bossAddress: '5hm72Yg27zw2sERwgKNBy9qfHQ3h2BoUc2HWAKBQzxuD' };

function placeholder({ createdMinutesAgo, transferSignature } = {}) {
  return {
    _id: 'pending-id',
    line: 10003,
    eid: 100020010834,
    bossAddress: '436ixKQgrTevcydh2rPFLMh1YoD4rWw1jkLuwAXgqP2P',
    bossStatus: 'awaiting_funds',
    bossPending: true,
    createTime: new Date(Date.now() - createdMinutesAgo * 60 * 1000),
    ...(transferSignature ? { transferSignature } : {}),
  };
}

function stubRecovery(service, pending, updates = []) {
  service.findPending = async () => pending;
  service.ctx.model = {
    ExecuteData: {
      updateOne: async (filter, update) => {
        updates.push({ filter, ...update });
        return { matchedCount: 1 };
      },
    },
  };
}

function balance(value, slot) {
  return { context: { slot }, value };
}

function minContextSlotError() {
  const error = new Error(
    `failed to get balance for ${new PublicKey(ADDRESS).toBase58()}: Minimum context slot has not been reached`,
  );
  error.name = 'SolanaJSONRPCError';
  error.code = -32016;
  return error;
}
