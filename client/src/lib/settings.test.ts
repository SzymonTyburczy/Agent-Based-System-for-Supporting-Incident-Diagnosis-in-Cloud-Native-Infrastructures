import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultAuthor, setDefaultAuthor } from "./settings";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("default author", () => {
  it("round-trips a trimmed value through localStorage", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    expect(getDefaultAuthor()).toBe("");
    expect(setDefaultAuthor("  Jan Kowalski  ")).toBe(true);
    expect(getDefaultAuthor()).toBe("Jan Kowalski");
  });

  it("degrades to no default when the browser blocks site storage", () => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });

    expect(getDefaultAuthor()).toBe("");
    // Reported, not thrown, so the page can say the save did not happen.
    expect(setDefaultAuthor("Jan Kowalski")).toBe(false);
  });
});
