import { describe, expect, it } from "vitest";
import { isWideRoute } from "./layout";

describe("isWideRoute", () => {
  it("is always wide on the knowledge base", () => {
    expect(isWideRoute("/knowledge-base", "")).toBe(true);
    expect(isWideRoute("/knowledge-base/", "?doc=abc")).toBe(true);
  });

  it("is wide on an issue only while a document is open beside it", () => {
    expect(isWideRoute("/issues/rep-1", "?doc=abc&cite=KB1")).toBe(true);
    expect(isWideRoute("/issues/rep-1", "?cite=KB1&doc=abc")).toBe(true);
    expect(isWideRoute("/issues/rep-1", "")).toBe(false);
    expect(isWideRoute("/issues/rep-1", "?doc=")).toBe(false);
  });

  it("stays narrow everywhere else, whatever the query string", () => {
    for (const path of ["/", "/issues", "/documentation", "/issues/rep-1/extra", "/settings"]) {
      expect(isWideRoute(path, "?doc=abc")).toBe(false);
    }
  });
});
