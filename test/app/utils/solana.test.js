const { strict: assert } = require('node:assert');
const { PublicKey } = require('@solana/web3.js');

const { getSPLBalance } = require('../../../app/utils/solana');

describe('getSPLBalance', () => {
  const mint = new PublicKey('DH1sax96GPQeUgYopCg4QNbaLp4tqcCYKtuzuSGQpump');
  const owner = new PublicKey(
    '8QjXvpv5oAd3bdfxQmFmpss3Dw59NVSEq2A1mtdkXgq3',
  );

  it('sums every token account owned by the wallet for the mint', async () => {
    let receivedOwner;
    let receivedFilter;
    let receivedCommitment;
    const connection = {
      async getParsedTokenAccountsByOwner(
        accountOwner,
        filter,
        commitment,
      ) {
        receivedOwner = accountOwner;
        receivedFilter = filter;
        receivedCommitment = commitment;
        return {
          value: [
            parsedTokenAccount('6731956.435771'),
            parsedTokenAccount('10.5'),
          ],
        };
      },
    };

    const balance = await getSPLBalance(connection, mint, owner);

    assert.equal(balance, 6731966.935771);
    assert(receivedOwner.equals(owner));
    assert(receivedFilter.mint.equals(mint));
    assert.equal(receivedCommitment, 'confirmed');
  });

  it('ignores malformed token accounts', async () => {
    const connection = {
      async getParsedTokenAccountsByOwner() {
        return {
          value: [
            parsedTokenAccount('12.25'),
            { account: { data: { parsed: { info: {} } } } },
          ],
        };
      },
    };

    assert.equal(await getSPLBalance(connection, mint, owner), 12.25);
  });

  it('returns zero when the RPC query fails', async () => {
    const connection = {
      async getParsedTokenAccountsByOwner() {
        throw new Error('RPC unavailable');
      },
    };

    assert.equal(await getSPLBalance(connection, mint, owner), 0);
  });
});

function parsedTokenAccount(uiAmountString) {
  return {
    account: {
      data: {
        parsed: {
          info: {
            tokenAmount: { uiAmountString },
          },
        },
      },
    },
  };
}
