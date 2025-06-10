const multiConfig = {
  transferAmount: 0.3,
  buyAmount: [0.02, 0.03, 0.04],
  limit: 136396,
  price: 146632,
  fee: 0.0002,
  firstBuy: false,
  secondBuy: true,
  multiBuy: true,
};
const WALLET_CONFIGS = [
  {
    transferAmount: 0.3,
    buyAmount: [0.13],
    limit: 200000,
    price: 250000,
    fee: 0.00005,
    firstBuy: true,
    secondBuy: false,
  },
  {
    transferAmount: 1.5,
    buyAmount: [1.33],
    limit: 150000,
    price: 333333,
    fee: 0.00005,
    firstBuy: true,
    secondBuy: false,
  },
  { ...multiConfig },
  { ...multiConfig },
  { ...multiConfig },
];

const testMultiConfig = {
  transferAmount: 0.03,
  buyAmount: [0.002, 0.003, 0.004],
  limit: 136396,
  price: 146632,
  fee: 0.00002,
  firstBuy: false,
  secondBuy: true,
  multiBuy: true,
};

const TEST_WALLET_CONFIGS = [
  {
    transferAmount: 0.03,
    buyAmount: [0.013],
    limit: 200000,
    price: 250000,
    fee: 0.00005,
    firstBuy: true,
    secondBuy: false,
  },
  {
    transferAmount: 0.15,
    buyAmount: [0.13],
    limit: 150000,
    price: 333333,
    fee: 0.00005,
    firstBuy: true,
    secondBuy: false,
  },
  { ...testMultiConfig },
  { ...testMultiConfig },
  { ...testMultiConfig },
];

console.log(JSON.stringify(TEST_WALLET_CONFIGS));
