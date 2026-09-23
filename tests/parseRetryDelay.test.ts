import { describe, expect, it } from "vitest";
import { parseRetryDelayMs } from "../src/scripts/aiProvider.js";

const h = (init: Record<string, string> = {}) => new Headers(init);

describe("parseRetryDelayMs", () => {
  it("reads Retry-After given in seconds", () => {
    expect(parseRetryDelayMs(h({ "retry-after": "30" }), "")).toBe(30_000);
  });

  it("reads Retry-After given as an HTTP date", () => {
    const when = new Date(Date.now() + 20_000).toUTCString();
    const ms = parseRetryDelayMs(h({ "retry-after": when }), "");
    expect(ms).toBeGreaterThan(17_000);
    expect(ms).toBeLessThanOrEqual(21_000);
  });

  it("reads Gemini's RetryInfo.retryDelay from the body", () => {
    const body = `{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"8s"}]}}`;
    expect(parseRetryDelayMs(h(), body)).toBe(8_000);
  });

  it("falls back to the prose form Gemini puts in the message", () => {
    // Verbatim shape from a real free-tier 429.
    expect(parseRetryDelayMs(h(), "Please retry in 8.922840237s.")).toBe(8_923);
  });

  it("returns undefined when the provider gave no hint", () => {
    expect(parseRetryDelayMs(h(), '{"error":{"code":500}}')).toBeUndefined();
  });

  it("prefers the header over the body when both are present", () => {
    expect(parseRetryDelayMs(h({ "retry-after": "2" }), '"retryDelay": "45s"')).toBe(2_000);
  });
});
