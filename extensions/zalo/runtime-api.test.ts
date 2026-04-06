import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("zalo runtime api", () => {
  it("keeps the runtime seam free of the local plugin export", async () => {
    const source = fs.readFileSync(path.resolve("extensions/zalo/runtime-api.ts"), "utf8");

    expect(source.includes('export { zaloPlugin } from "./src/channel.js";')).toBe(false);
    expect(source.includes('export * from "./api.js";')).toBe(false);
    expect(source.includes('export { setZaloRuntime } from "./src/runtime.js";')).toBe(true);
  });
});
