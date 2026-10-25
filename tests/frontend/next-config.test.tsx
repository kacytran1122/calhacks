import { describe, expect, test } from "vitest";
import { validatedBackendOrigin } from "../../frontend/next.config";

describe("backend proxy configuration", () => {
  test("accepts only a public HTTPS origin", () => {
    expect(validatedBackendOrigin(undefined)).toBeUndefined();
    expect(validatedBackendOrigin(" https://api.example.com/ ")).toBe("https://api.example.com");
    for (const value of [
      "http://api.example.com",
      "https://localhost.",
      "https://service.localhost.",
      "https://service.local.",
      "https://127.1",
      "https://2130706433",
      "https://[::]",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "https://api.example.com/path",
      "https://api.example.com?query=yes",
      "https://user:password@api.example.com",
    ]) expect(() => validatedBackendOrigin(value)).toThrow(/public HTTPS origin/);
  });
});
