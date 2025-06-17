const line12 = require("./line1-2-1.json");
const line2 = require("./line2.json");
const line1v4 = require("./line1-4.json");
function main() {
  const testConfig = line1v4.map((item) => {
    const buyAmount = item.buyAmount.map((amount) =>
      parseFloat((amount / 10).toFixed(3))
    );
    return {
      ...item,
      transferAmount: item.transferAmount / 10,
      buyAmount: buyAmount,
    };
  });

  console.log(JSON.stringify(testConfig));
}

main();
