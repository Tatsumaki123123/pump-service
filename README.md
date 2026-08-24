# pump-service

https://mainnet.helius-rpc.com/?api-key=8a4cbdb4-5eb7-4c51-bdbb-1cf240d50b18

RPC_URL=https://mainnet.helius-rpc.com/?api-key=8a4cbdb4-5eb7-4c51-bdbb-1cf240d50b18
WSS_RPC_URL=wss://mainnet.helius-rpc.com/?api-key=8a4cbdb4-5eb7-4c51-bdbb-1cf240d50b18

RPC_URL=https://little-practical-lake.solana-mainnet.quiknode.pro/748dd52b1227a0602d41ef4ac30d2b4a01f39dc3/
WSS_RPC_URL=wss://little-practical-lake.solana-mainnet.quiknode.pro/748dd52b1227a0602d41ef4ac30d2b4a01f39dc3/

RPC_URL=https://edge.erpc.global?api-key=e8782e9b-dc7c-4bd4-b931-012e4f8f0dde
WSS_RPC_URL=wss://edge.erpc.global?api-key=e8782e9b-dc7c-4bd4-b931-012e4f8f0dde

```bash
time curl -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

## QuickStart

接口说明见 [Wallet API 文档](docs/wallet-api.md)。

see [egg docs][egg] for more detail.

### Development

```bash
npm i
npm run dev
open http://localhost:7001/
```

### Deploy

```bash
npm start
npm stop
```

### npm scripts

- Use `npm run lint` to check code style.
- Use `npm test` to run unit test.

[egg]: https://eggjs.org
