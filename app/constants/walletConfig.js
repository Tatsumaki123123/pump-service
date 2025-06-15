const line2 = require("./line1-2-7.json");
function main() {
  const testConfig = line2.map((item) => {
    const buyAmount = item.buyAmount.map((amount) => amount / 10);
    return {
      ...item,
      transferAmount: item.transferAmount / 10,
      buyAmount: buyAmount,
    };
  });

  console.log(JSON.stringify(testConfig));
}

main();
