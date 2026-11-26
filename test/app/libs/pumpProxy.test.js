const { strict: assert } = require("node:assert");
const bs58 = require("bs58");
const { PublicKey } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const PumpSwapSDK = require("../../../app/libs/pumpSwap");
const { getPumpAmmWsolProtocolFeeAccounts } = require("../../../app/libs/constants");
const {
  createProxyBuyInstruction,
  getProxyBuyInstruction,
  setProxyBuyMinBaseAmountOut,
} = require("../../../app/libs/pumpProxy");

describe("Pump AMM v1 protocol fees", () => {
  it("puts the new fee pair in the direct buy instruction without changing its ABI", async () => {
    const sdk = new PumpSwapSDK();
    const tokenMint = new PublicKey("GFmaQAffLD1B4BxJuuQHmqxHqWavaSJGrYFCXQAypump");
    const poolData = {
      poolBaseTokenAccount: new PublicKey("A2xmjeJWWEjq5c1G3AvsWn6dJmAiCtTtjioRidon6XiF"),
      poolQuoteTokenAccount: new PublicKey("BFQ5cYwwRqSAE1ooQkaRE1rM2kqeVcC9GhfH8D1VA1ey"),
      coinCreator: new PublicKey("CPM9ey7xqLug3LFk6L9L8sJXCR7XptJViJXojMjoe4ge"),
      is_cashback: false,
    };
    const user = new PublicKey("EhB7Ny4MD7XyWovLFHnmZMZR9f8jRBrY63RFULfpwXtE");
    const params = {
      user,
      tokenMint,
      buyAmount: 0.4,
      tokenProgramId: TOKEN_2022_PROGRAM_ID,
      poolDetail: {
        address: new PublicKey("FocsQEiR3miFMAsqgYxouCHZkyoMzc63B9yHEgo4L6xF"),
        poolData,
      },
    };
    const ix = await sdk.createBuyExactQuoteInInstruction(params);
    assert.equal(sdk.getBuyExactQuoteInInstruction([ix]), ix);
    assert.equal(ix.data.subarray(0, 8).toString("hex"), "c62e1552b4d9e870");
    assert.equal(ix.data.readBigUInt64LE(8), 400000000n);
    assert.equal(ix.data.readBigUInt64LE(16), (1n << 64n) - 1n);
    assert.equal(ix.keys.length, 26);
    assert.equal(ix.keys[9].pubkey.toBase58(), "2aSWZ3QXsNLVVBr1UB1HxSw7sqMRR2pv2qa5ohsTi5Gp");
    assert.equal(ix.keys[10].pubkey.toBase58(), "CsDLPvWtEm5hZHVzPwxsZaurz19Lu4aGWo6twx65tZ1r");
    assert.equal(ix.keys[10].isWritable, true);
    assert(ix.keys[11].pubkey.equals(TOKEN_2022_PROGRAM_ID));

    poolData.is_mayhem = true;
    const mayhemIx = await sdk.createBuyExactQuoteInInstruction(params);
    assert.equal(mayhemIx.keys[9].pubkey.toBase58(), "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS");
    assert.equal(ix.keys[9].pubkey.toBase58(), "2aSWZ3QXsNLVVBr1UB1HxSw7sqMRR2pv2qa5ohsTi5Gp");
  });

  it("derives the ATA from the override and rejects stale fee configurations", () => {
    const prefix = "TEST_PUMP_AMM";
    const recipientKey = `${prefix}_PROTOCOL_FEE_RECIPIENT`;
    const ataKey = `${recipientKey}_TOKEN_ACCOUNT`;
    try {
      process.env[recipientKey] = "DrcDxWxLi3i7Yd7cTyCyd44DE7pwS9BvFxSsPx1c7XTv";
      const { recipient, tokenAccount } = getPumpAmmWsolProtocolFeeAccounts(false, prefix);
      assert.equal(recipient.toBase58(), process.env[recipientKey]);
      assert.equal(tokenAccount.toBase58(), "FLZwYtTwLegv9LhG5bwn5NBS93RiAoQVnwBKqoxv2zhM");
      process.env[ataKey] = tokenAccount.toBase58();
      assert(getPumpAmmWsolProtocolFeeAccounts(false, prefix).tokenAccount.equals(tokenAccount));
      process.env[ataKey] = "94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb";
      assert.throws(() => getPumpAmmWsolProtocolFeeAccounts(false, prefix), /must match the WSOL ATA/);
      process.env[recipientKey] = "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV";
      assert.throws(() => getPumpAmmWsolProtocolFeeAccounts(false, prefix), /is retired/);
      assert.equal(getPumpAmmWsolProtocolFeeAccounts(true, prefix).recipient.toBase58(),
        "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS");
    } finally {
      delete process.env[recipientKey];
      delete process.env[ataKey];
    }
  });
});

describe("Pump AMM proxy buy", () => {
  it("preserves the proxy ABI using the rotated protocol fee accounts", async () => {
    const addresses = [
      "7EL3TNBKnRDFsGe1zGZt2BpjXeJGDyAM5mSSfLsKKVcx",
      "7LmPhLf1pRK6nWDzc9fDk1NBJ29wHZ1LFq15AQi6rnV9",
      "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw",
      "J8cysDDrTEUwNfccbPqhvWHded5a8cyipVMu5CcGpump",
      "So11111111111111111111111111111111111111112",
      "HYAP239hHQYPsSYWWa3W1vwDXmPixQELhEwdphnJkTvt",
      "HZzyJ5KK13ExugfuzH6vc7GqUjHtdESQ9GA5v9NuyxPW",
      "69GjHB824LqnkqgcV66Z67hLe33R774ixNktfU87L7MW",
      "EXgtbgK8ppibrqnxQ52cSSzgftWfzkFbunQa7JuAP7p6",
      "2aSWZ3QXsNLVVBr1UB1HxSw7sqMRR2pv2qa5ohsTi5Gp",
      "CsDLPvWtEm5hZHVzPwxsZaurz19Lu4aGWo6twx65tZ1r",
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "11111111111111111111111111111111",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR",
      "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
      "4pXY7nfXPETgCoq17fj7nULoUn5kn1y6TmzrRsw1qFy1",
      "C87MmW4CyL7XPRGoBjuogDfz4Kzw3TWTozWnm7zerajm",
      "C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw",
      "9zpqtCHfrAv28FFRm6c7dAsgtcsGwX2CR2isUnHtPTzC",
      "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx",
      "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
      "wNRV9s4MgNsbe4MTiHnLL3rPHN94UjRN6GzT6CX8uBL",
      "DDEbmVeEp1z2brNMC8RJ18xSP1DitRDMbU8FgaWB38mu",
      "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
      "6rVkF4HSgy1jrnC3HogfRgPHrq4CtLg5f11URpsC4i9D",
    ];
    const pk = (index) => new PublicKey(addresses[index]);
    const instruction = await createProxyBuyInstruction({
      user: pk(1),
      tokenMint: pk(3),
      buyAmount: 0.6,
      tokenProgramId: pk(11),
      poolDetail: {
        address: pk(0),
        poolData: {
          poolBaseTokenAccount: pk(7),
          poolQuoteTokenAccount: pk(8),
          coinCreator: new PublicKey("B3UTwYsHiXwAXs9q66zsZazyUN8Yp8axMswdbfPbyTRt"),
          is_cashback: false,
        },
      },
    });
    assert.equal(instruction.programId.toBase58(), "m9obQHAPyZeZ88w7XUY8Te6a8rBmhXsfKco7u8G8tnB");
    assert.deepEqual(instruction.keys.map(({ pubkey }) => pubkey.toBase58()), addresses);
    assert.deepEqual(
      instruction.keys.map(({ isSigner, isWritable }) => [isSigner, isWritable]),
      addresses.map((_, index) => [index === 1,
        [0, 1, 5, 6, 7, 8, 10, 17, 19, 20, 23, 26].includes(index)]),
    );
    assert.equal(instruction.data.readBigUInt64LE(8), 600000000n);
    assert.equal(instruction.data.readUInt16LE(24), 100);
    assert.equal(getProxyBuyInstruction([instruction]), instruction);
    setProxyBuyMinBaseAmountOut(instruction, 4623355882865n);
    assert.deepEqual(instruction.data, Buffer.from(bs58.decode("yTkoMJ4365gvK7csHmeHKru9SBTkNLPw5cK")));
  });
});
