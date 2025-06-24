"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const pumpswap_1 = require("./pumpswap");
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@coral-xyz/anchor");
const bytes_1 = require("@coral-xyz/anchor/dist/cjs/utils/bytes");
const poolswap_1 = require("./poolswap");
const util_1 = require("./util");
const spl_token_1 = require("@solana/spl-token");
async function sendV0Transaction(connection, user, instructions, lookupTableAccounts) {
    // Get the latest blockhash and last valid block height
    const { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash({ commitment: "confirmed" });
    // Create a new transaction message with the provided instructions
    const messageV0 = new web3_js_1.TransactionMessage({
        payerKey: user.publicKey, // The payer (i.e., the account that will pay for the transaction fees)
        recentBlockhash: blockhash, // The blockhash of the most recent block
        instructions: [
            web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: 100000 * 1,
            }),
            ...instructions,
        ], // The instructions to include in the transaction
    }).compileToV0Message(lookupTableAccounts ? lookupTableAccounts : undefined);
    // Create a new transaction object with the message
    const transaction = new web3_js_1.VersionedTransaction(messageV0);
    // Sign the transaction with the user's keypair
    transaction.sign([user]);
    console.log(`sendRawTransaction`, Buffer.from(transaction.serialize()).toString("base64"));
    // const jitoConnection = new Connection(
    //   "https://mainnet.block-engine.jito.wtf/api/v1/transactions",
    //   "confirmed"
    // )
    // Send the transaction to the cluster
    const txid = await connection.sendTransaction(transaction, {
        skipPreflight: true,
        maxRetries: 2,
    });
    await connection.confirmTransaction({
        blockhash: blockhash,
        lastValidBlockHeight: lastValidBlockHeight,
        signature: txid,
    }, "confirmed");
    // Log the transaction URL on the Solana Explorer
    console.log(`https://explorer.solana.com/tx/${txid}`);
}
const executePumpswapBuy = async () => {
    try {
        const keypair = web3_js_1.Keypair.fromSecretKey(bytes_1.bs58.decode(process.env.KEY));
        const pubKey = keypair.publicKey;
        const mint = new web3_js_1.PublicKey("7sN5VPJ4kJ38M4uMPDWVhJ4iB5RE3xLkMv7qDByfpump"); // Replace with actual mint address
        console.log("Wallet address:", pubKey.toBase58());
        const connection = new web3_js_1.Connection(process.env.RPC_URL, "confirmed");
        const provider = new anchor_1.AnchorProvider(connection, {}, {
            commitment: "finalized",
        });
        const pumpswap = new pumpswap_1.PumpSwapSDK(provider);
        const user = pubKey;
        const solAmount = 1000000n; // Amount of SOL to buy with
        const solAmountWithSlippage = (0, util_1.calculateWithSlippageBuy)(solAmount, 500n);
        const pumpSwapPool = new poolswap_1.PumpSwapPool(provider);
        // console.log("globalConfig", globalConfig);
        const pool = await pumpSwapPool.getPoolsWithPrices(mint);
        const currentPool = pool[0];
        const { baseAmountOut, maxQuote } = await pumpSwapPool.getBuyTokenAmount(solAmount, mint, 500, currentPool);
        console.log("Pool:", pool[0].address.toBase58(), "Amount:", baseAmountOut.toNumber());
        const buyTx = await pumpswap.createBuyInstruction(pool[0].address, user, mint, BigInt(baseAmountOut.toString()), solAmountWithSlippage, "confirmed");
        await sendV0Transaction(connection, keypair, [...buyTx.instructions]);
        // return buyTx;
    }
    catch (error) {
        console.error("Error executing Pumpswap buy:", error);
        throw error;
    }
};
const executePumpswapSell = async () => {
    try {
        const keypair = web3_js_1.Keypair.fromSecretKey(bytes_1.bs58.decode(process.env.KEY));
        const pubKey = keypair.publicKey;
        const mint = new web3_js_1.PublicKey("7sN5VPJ4kJ38M4uMPDWVhJ4iB5RE3xLkMv7qDByfpump"); // Replace with actual mint address
        console.log("Wallet address:", pubKey.toBase58());
        const connection = new web3_js_1.Connection(process.env.RPC_URL, "confirmed");
        const provider = new anchor_1.AnchorProvider(connection, {}, {
            commitment: "finalized",
        });
        const pumpswap = new pumpswap_1.PumpSwapSDK(provider);
        const ata = (0, spl_token_1.getAssociatedTokenAddressSync)(mint, pubKey);
        const balance = await connection.getTokenAccountBalance(ata);
        // console.log("Balance:", balance.value.amount);
        const user = pubKey;
        const pumpSwapPool = new poolswap_1.PumpSwapPool(provider);
        const pool = await pumpSwapPool.getPoolsWithPrices(mint);
        console.log(pool.map((x) => x.address), "price", pool.map((x) => x.price));
        const solAmount = await pumpSwapPool.getSellTokenAmount(BigInt(balance.value.amount), mint, 500, pool[0]);
        // const solAmount = 100_000n; // Amount of SOL to buy with
        const solAmountWithSlippage = (0, util_1.calculateWithSlippageSell)(BigInt(solAmount.toString()), 500n);
        // console.log("Pool:", pool[0].address.toBase58(), "Amount:", amount);
        const sellTx = await pumpswap.createSellInstruction(pool[0].address, user, mint, BigInt(balance.value.amount), solAmountWithSlippage);
        await sendV0Transaction(connection, keypair, [...sellTx.instructions]);
        return sellTx;
    }
    catch (error) {
        console.error("Error executing Pumpswap buy:", error);
        throw error;
    }
};
const decodePumpTx = async () => {
    try {
        const keypair = web3_js_1.Keypair.fromSecretKey(bytes_1.bs58.decode(process.env.KEY));
        const pubKey = keypair.publicKey;
        const mint = new web3_js_1.PublicKey("Dfn5mX8TGwFruQyYcMoJp7f62iu9uYGDWnsfhTQcpump"); // Replace with actual mint address
        console.log("Wallet address:", pubKey.toBase58());
        const connection = new web3_js_1.Connection(process.env.RPC_URL, "confirmed");
        const provider = new anchor_1.AnchorProvider(connection, {}, {
            commitment: "finalized",
        });
        const pumpswap = new pumpswap_1.PumpSwapSDK(provider);
        const pumpSwapPool = new poolswap_1.PumpSwapPool(provider);
        const pools = await pumpSwapPool.getPoolsWithPrices(mint);
        const pool = await pumpSwapPool.getPoolDataFromPoolId(pools[0].address);
        if (pool) {
            const poolWithPrice = await pumpSwapPool.getPriceAndLiquidity(pool);
            console.log("poolWithPrice", poolWithPrice.reserves.native, poolWithPrice.reserves.token);
        }
        // console.log("b1", b1.value.amount, b1.value.decimals);
        // const txRaw =
        //   "AYiB/ytPn6gYQt6UIO13XW94MxFPIAEkEzvUzWgkmEAu9k1iLfky9oxCAD+doVzUmnyD2NI4SGsWpjzI1OnhsQGAAQAKEuEbUwiDyLi5HqdFJwDhVVAMkDo3SyOTqyTI1XDoKmH7N1S2UHXfZ0z0OMfTnre3MEVqXtgKoy6zP3pE2XL16m/mkIZwDcZRgjrWXRRaN8u41mJR0yyZrziqM0iZz9MGeJTV9rzYhnngg9CL8gdW+gJpzMMDxTrH/+QhtODqI+pUIpgV5G7X7f9v1mS2MNcyyRc5d+ivZueHsYYtaMX0t/w1FGR31TzjHrB9ppATzFeTjRPNBSqqxUlQF4DsUQiAfm+kIRZTVh5jvFTyM7GXM2bUj+W5qLARPTQJH4fV6ULObmpdnaEmj6IDt38x7V8XTnOH2wKbiGxpZEbysTqqoCUDBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAIyXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpLIWDiRUWqZY70AYgK1FbxzDijnkdnQLeeKzqU353oI8MFN78gl7GdpQlCBi7ZUBl9CmNMVbVcbTU+AkMGOmoY4kLpkT+H1WqGfEc0tLsFNMjO24KS+ru9ytphY4h4XDWBt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/zlSnCVKIOfYcC5uGB5iRwTkhbkenG2L7c77HIWlFh0Xo64BauidpEtQ8276X2LfykdOpukhxV2yfsmwty+aNOuCQgABQKLygIACAAJA6CGAQAAAAAACQYAAQAKCwwBAQsCAAEMAgAAAOHk9wQAAAAADAEBAREJBgACAw0LDAEBCQYABAMKCwwBAQ4SAw8ADQoFBgEHAgQLEAwMCREOGumS0Y7PaEC8AAAAAGSns7bgDeHk9wQAAAAADAMBAAABCQA=";
        // const txBuffer = Buffer.from(txRaw, "base64");
        // const tx = VersionedTransaction.deserialize(txBuffer);
        // const createPoolTx = tx.message.compiledInstructions.filter((x) => x.accountKeyIndexes.length == 24).shift();
        // console.log("createPoolTx", createPoolTx);
    }
    catch (error) {
        console.error("Error executing Pumpswap buy:", error);
        throw error;
    }
};
// Execute the buy using async/await
const init = async () => {
    try {
        // await decodePumpTx();
        // await executePumpswapBuy();
        await executePumpswapSell();
        console.log("Pumpswap buy executed successfully");
    }
    catch (err) {
        console.error("Failed to execute Pumpswap buy:", err);
    }
};
init();
//# sourceMappingURL=test.js.map