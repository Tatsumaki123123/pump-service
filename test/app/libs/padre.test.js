const { strict: assert } = require('node:assert');
const bs58 = require('bs58');
const { TransactionInstruction } = require('@solana/web3.js');
const {
  PADRE_PROGRAM_ID,
  isPadreRouteInstruction,
  setPadreRouteMinFinalOut,
} = require('../../../app/libs/padre');

describe('Padre Route quote patch', () => {
  it('selects Route after nonce instructions and changes only its minimum output', () => {
    // Encoded nonce and Route data from a successful Terminal Pump AMM buy.
    const data = [
      'WPNHsFPyEMr',
      'DVGvGmyf25ww42',
      'hbfuVEmSEBDfEQ2XJQi1e12bL4V9HYQyWsUGaL1cGEaBznk5rmuAStAJJxN9CoruQDmYRfxft6Kv2c1aKy',
    ];
    const instructions = data.map((encoded) => new TransactionInstruction({
      programId: PADRE_PROGRAM_ID,
      keys: [],
      data: Buffer.from(bs58.decode(encoded)),
    }));

    assert.deepEqual(instructions.map(isPadreRouteInstruction), [false, false, true]);
    const route = instructions.find(isPadreRouteInstruction);
    const original = Buffer.from(route.data);
    assert.equal(route.data.readBigUInt64LE(39), 10_000_000n);

    setPadreRouteMinFinalOut(route, 235_287_964_653n);

    assert.equal(route.data.readBigUInt64LE(47), 235_287_964_653n);
    assert.deepEqual(route.data.subarray(0, 47), original.subarray(0, 47));
    assert.deepEqual(route.data.subarray(55), original.subarray(55));
  });
});
