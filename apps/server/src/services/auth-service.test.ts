import { describe, expect, it } from "vitest";

import { resolveRequestOriginInfo, resolveSecureCookieRequirement } from "./auth-service.js";

describe("resolveRequestOriginInfo", () => {
  it("uses the canonical remote origin when bootstrap registration is pinned to a canonical URL", () => {
    expect(
      resolveRequestOriginInfo({
        requestUrl: "http://127.0.0.1:4318/api/auth/register/options?bootstrap=test",
        requestOriginHeader: "https://mac.taila06290.ts.net",
        canonicalOrigin: {
          origin: "https://mac.taila06290.ts.net",
          rpId: "mac.taila06290.ts.net"
        }
      })
    ).toEqual({
      origin: "https://mac.taila06290.ts.net",
      rpId: "mac.taila06290.ts.net"
    });
  });

  it("prefers the browser origin header over the local server URL", () => {
    expect(
      resolveRequestOriginInfo({
        requestUrl: "http://127.0.0.1:4318/api/auth/login/options",
        requestOriginHeader: "https://mac.taila06290.ts.net"
      })
    ).toEqual({
      origin: "https://mac.taila06290.ts.net",
      rpId: "mac.taila06290.ts.net"
    });
  });
});

describe("resolveSecureCookieRequirement", () => {
  it("requires secure cookies for canonical https origins even when the local server transport is http", () => {
    expect(
      resolveSecureCookieRequirement({
        requestUrl: "http://127.0.0.1:4318/api/auth/register/verify?bootstrap=test",
        requestOriginHeader: "https://mac.taila06290.ts.net",
        canonicalOrigin: {
          origin: "https://mac.taila06290.ts.net"
        }
      })
    ).toBe(true);
  });

  it("does not require secure cookies for plain localhost bootstrap", () => {
    expect(
      resolveSecureCookieRequirement({
        requestUrl: "http://localhost:4318/api/auth/register/verify",
        requestOriginHeader: "http://localhost:4318"
      })
    ).toBe(false);
  });
});
