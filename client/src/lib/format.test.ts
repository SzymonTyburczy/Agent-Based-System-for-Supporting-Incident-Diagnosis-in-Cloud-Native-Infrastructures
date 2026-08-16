import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatUtcTimestamp } from "./format";

// tsconfig deliberately exposes only vite/client types to src, so browser code
// cannot reach for Node APIs. This one test needs the runtime's timezone.
declare const process: { env: Record<string, string | undefined> };

describe("formatUtcTimestamp", () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    // Pin a non-UTC zone: the point of this function is that it does NOT
    // follow the host timezone the way formatIssueDate deliberately does.
    process.env.TZ = "Asia/Tokyo";
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

  it("renders the instant in UTC regardless of the host timezone", () => {
    expect(formatUtcTimestamp("2026-07-18T14:30:00Z")).toBe("18/07/2026, 14:30 UTC");
  });

  it("falls back to an em dash for unusable input", () => {
    expect(formatUtcTimestamp("nonsense")).toBe("—");
    expect(formatUtcTimestamp("")).toBe("—");
  });
});
