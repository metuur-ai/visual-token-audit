import { expect, test } from "bun:test";
import { countTokens, tokenizerProvenance } from "./tokenizer.ts";

test("empty string is zero tokens", () => {
  expect(countTokens("")).toBe(0);
});

const prov = tokenizerProvenance();

if (prov === "o200k") {
  // Published o200k_base counts (cross-checked against tiktoken).
  test("o200k exact counts", () => {
    expect(countTokens("hello world")).toBe(2);
    expect(countTokens("hello")).toBe(1);
    expect(countTokens(" ")).toBe(1);
    expect(countTokens("2020")).toBe(2); // digits chunk in groups of ≤3: "202" + "0"
  });
} else {
  // Vocab absent → est fallback (bytes/4, floor 1). Exact counts not asserted.
  test("est fallback is positive and length-monotone", () => {
    expect(countTokens("hello world")).toBeGreaterThanOrEqual(1);
    expect(countTokens("a".repeat(400))).toBeGreaterThan(countTokens("a".repeat(4)));
  });
}
