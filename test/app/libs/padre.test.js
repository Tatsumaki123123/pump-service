const { strict: assert } = require('node:assert');
const bs58 = require('bs58');
const { PublicKey, SystemProgram, TransactionInstruction } = require('@solana/web3.js');
const {
  PADRE_PROGRAM_ID,
  PADRE_FEE_RECIPIENT,
  PADRE_FEE_BASIS_POINTS,
  createPadreRouteInstruction,
  createPadreNonceInstructions,
  getPadreNonceAccount,
  isPadreRouteInstruction,
  setPadreRouteMinFinalOut,
} = require('../../../app/libs/padre');

describe('Padre Route quote patch', () => {
  it('matches the platform fee fields and account order', () => {
    const platformRoute = Buffer.from(bs58.decode(
      'hbfuVEmSEBDfEQ2XJQiC4k2ya54mu2UnvEQpkdxMxhs2YyDpTZErxVAbMDqPBJvfq2VFXCrv6pZJKGxLZD',
    ));
    const user = new PublicKey('4UewoZUyBxNqQrz85zANSyU6Yb8zuSHyUtmisM1Tumc5');
    const inputTokenAccount = new PublicKey('GShCUdkt992CqxNabqFr5YDfcC7bvJXkosYaKX7A2jQw');
    const inputMint = new PublicKey('So11111111111111111111111111111111111111112');
    const outputTokenAccount = new PublicKey('C9cpFVz8HDvd2b5AuESo3A9QAjUTvdv9s9WRd4MoGffw');
    const outputMint = new PublicKey('7dvY8Ww9hYUeM2zN6vLXrn2JGwymjfbupQu4yz76pump');
    const platformAccounts = [
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      '6uvDnRAvtjvHFdyYExf14wWYwsZnnQCeuc7sF9uhZK4i',
      'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw',
      '7dvY8Ww9hYUeM2zN6vLXrn2JGwymjfbupQu4yz76pump',
      'So11111111111111111111111111111111111111112',
      'GShCUdkt992CqxNabqFr5YDfcC7bvJXkosYaKX7A2jQw',
      'C9cpFVz8HDvd2b5AuESo3A9QAjUTvdv9s9WRd4MoGffw',
      'DdfKZWRJM3e7KPkZJVL1TnNuMMbe8kXaJSeSbhefK6dM',
      'GmbSVeSpEHVH1Tnvik8UyR4bBkSSesGCJyrXPBM2LELk',
      '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
      'X5QPJcpph4mBAJDzc4hRziFftSbcygV59kRb2Fu6Je1',
      'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR',
      '5Rh4xrZ1ubRiFpJyJLfkSkoLvP7AXyvddZKyCGaChzhG',
      '65Meho5q6mu9wYtJktnR22ehXUgv2D24KuSKanvKyUtq',
      '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx',
      'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
      'C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw',
      'ArBxm6HakFi7JM4xeBgGGp5m4dqskkAP33TutHk3stN8',
      'J942qcQEJzUWDPSdoKHdp6Ez8dKwKxf8uP9cep7FcryS',
      '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
      '6rVkF4HSgy1jrnC3HogfRgPHrq4CtLg5f11URpsC4i9D',
    ];
    const hopKeys = platformAccounts.map((account) => ({
      pubkey: new PublicKey(account), isSigner: false, isWritable: false,
    }));
    const route = createPadreRouteInstruction({
      user,
      inputAmount: 9_900_000n,
      minFinalOut: platformRoute.readBigUInt64LE(47),
      inputTokenAccount,
      outputTokenAccount,
      outputMint,
      hopKeys,
      feeBasisPoints: PADRE_FEE_BASIS_POINTS,
      feeRecipient: PADRE_FEE_RECIPIENT,
    });

    assert.deepEqual(route.data, platformRoute);
    assert.deepEqual(route.keys.slice(-5).map(({ pubkey }) => pubkey.toBase58()), [
      inputTokenAccount.toBase58(),
      PADRE_FEE_RECIPIENT.toBase58(),
      inputMint.toBase58(),
      inputTokenAccount.toBase58(),
      inputMint.toBase58(),
    ]);
    assert.equal(9_900_000n * BigInt(PADRE_FEE_BASIS_POINTS) / 10_000n, 99_000n);
  });

  it('builds the initial nonce instructions with the successful Terminal account layout', () => {
    const user = new PublicKey('6GVXG2rJMEQELudVzTf1JnSZ8kVuXMCobcGdDQP4W4FP');
    const nonce = Buffer.from(bs58.decode('DVGvGmyf25ww42')).readUInt16LE(8);
    const [init, update] = createPadreNonceInstructions(user, nonce, false);

    assert(getPadreNonceAccount(user).equals(
      new PublicKey('8s54zUBLRVAtjZadkXizeb8vU2crRRv6hvQoAbD1wE5'),
    ));
    assert.deepEqual(init.data, Buffer.from(bs58.decode('WPNHsFPyEMr')));
    assert.deepEqual(update.data, Buffer.from(bs58.decode('DVGvGmyf25ww42')));
    assert.deepEqual(init.keys.map(({ isSigner, isWritable }) => [isSigner, isWritable]), [
      [false, true], [true, true], [false, false],
    ]);
    assert(init.keys[2].pubkey.equals(SystemProgram.programId));
    assert.deepEqual(createPadreNonceInstructions(user, nonce, true).map(ix => ix.data), [update.data]);
  });

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
