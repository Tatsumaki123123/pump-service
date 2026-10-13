const { strict: assert } = require("node:assert");
const JupSDK = require("../../../app/libs/jup");

describe("Jupiter HTTP responses", () => {
  it("recovers when a quote request first receives an HTML 503", async () => {
    const responses = [
      { status: 503, data: "<html>Service Temporarily Unavailable</html>" },
      { status: 200, data: JSON.stringify({ outAmount: "123" }) },
    ];
    const calls = [];
    const ctx = {
      curl: async (uri, options) => {
        calls.push({ uri, options });
        return responses.shift();
      },
    };

    const quote = await new JupSDK().getQuote(ctx, "input", "output", "100", 0.2);
    assert.equal(quote.outAmount, "123");
    assert.equal(calls.length, 2);
    assert(calls.every(({ options }) => options.dataType === "text"));
    assert(calls[0].uri.includes("slippageBps=2000"));
  });

  it("reports an HTTP error without trying to parse its HTML body", async () => {
    let calls = 0;
    const ctx = {
      curl: async () => {
        calls++;
        return { status: 400, data: "<html>Bad Request</html>" };
      },
    };

    await assert.rejects(
      new JupSDK().getQuote(ctx, "input", "output", "100", 0.2),
      /Jupiter quote failed with HTTP 400 after 1 attempt/,
    );
    assert.equal(calls, 1);
  });

  it("stops after bounded retries when Jupiter keeps returning 503", async () => {
    let calls = 0;
    const ctx = {
      curl: async () => {
        calls++;
        return { status: 503, data: "<html>Service Temporarily Unavailable</html>" };
      },
    };

    await assert.rejects(
      new JupSDK().getQuote(ctx, "input", "output", "100", 0.2),
      /Jupiter quote failed with HTTP 503 after 4 attempt/,
    );
    assert.equal(calls, 4);
  });
});
