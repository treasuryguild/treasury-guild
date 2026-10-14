import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "./errors";
import {
  appUrl,
  cronSecret,
  devWallets,
  githubAppPrivateKey,
  isProduction,
  koiosBaseUrl,
  mcpTokenSecret,
  oauthStateSecret,
  pinataGateway,
  pinataJwt,
} from "./env.server";

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["PINATA_JWT", "PINATA_GATEWAY", "KOIOS_BASE_URL_MAINNET", "KOIOS_BASE_URL_PREPROD", "APP_URL", "GITHUB_APP_PRIVATE_KEY", "DEV_WALLETS"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("env.server", () => {
  it("throws a ConfigError for missing required vars", () => {
    delete process.env.PINATA_JWT;
    expect(() => pinataJwt()).toThrow(ConfigError);
    expect(() => pinataJwt()).toThrow(/PINATA_JWT/);
  });

  it("applies defaults for optional vars", () => {
    delete process.env.PINATA_GATEWAY;
    delete process.env.APP_URL;
    expect(pinataGateway()).toBe("gateway.pinata.cloud");
    expect(appUrl()).toBe("http://localhost:3000");
  });

  it("selects the Koios base URL per network, overridable per network", () => {
    delete process.env.KOIOS_BASE_URL_MAINNET;
    delete process.env.KOIOS_BASE_URL_PREPROD;
    expect(koiosBaseUrl(0)).toBe("https://preprod.koios.rest/api/v1");
    expect(koiosBaseUrl(1)).toBe("https://api.koios.rest/api/v1");
    process.env.KOIOS_BASE_URL_MAINNET = "https://mirror.example/api/v1";
    expect(koiosBaseUrl(1)).toBe("https://mirror.example/api/v1");
    // A mainnet override never bleeds into preprod.
    expect(koiosBaseUrl(0)).toBe("https://preprod.koios.rest/api/v1");
  });

  it("parses the developer wallet list, empty when unset", () => {
    delete process.env.DEV_WALLETS;
    expect(devWallets()).toEqual([]);
    process.env.DEV_WALLETS = " addr1a, addr1b ,,addr1c ";
    expect(devWallets()).toEqual(["addr1a", "addr1b", "addr1c"]);
  });

  it("unescapes the GitHub private key", () => {
    process.env.GITHUB_APP_PRIVATE_KEY = "line1\\nline2";
    expect(githubAppPrivateKey()).toBe("line1\nline2");
  });
});

describe("token and state secrets", () => {
  const env = process.env as Record<string, string | undefined>;
  const KEYS = ["NODE_ENV", "MCP_TOKEN_SECRET", "OAUTH_STATE_SECRET", "CRON_SECRET"] as const;
  const before = Object.fromEntries(KEYS.map((key) => [key, env[key]]));
  afterEach(() => {
    for (const key of KEYS) {
      if (before[key] === undefined) delete env[key];
      else env[key] = before[key];
    }
  });

  it("knows production by NODE_ENV alone", () => {
    env.NODE_ENV = "production";
    expect(isProduction()).toBe(true);
    env.NODE_ENV = "test";
    expect(isProduction()).toBe(false);
    env.NODE_ENV = "development";
    expect(isProduction()).toBe(false);
    delete env.NODE_ENV;
    expect(isProduction()).toBe(false);
  });

  it("requires MCP_TOKEN_SECRET in production", () => {
    env.NODE_ENV = "production";
    delete env.MCP_TOKEN_SECRET;
    expect(() => mcpTokenSecret()).toThrow(ConfigError);
    expect(() => mcpTokenSecret()).toThrow("MCP_TOKEN_SECRET is not configured");
    env.MCP_TOKEN_SECRET = "";
    expect(() => mcpTokenSecret()).toThrow("MCP_TOKEN_SECRET is not configured");
  });

  it("does not let CRON_SECRET stand in for it in production", () => {
    env.NODE_ENV = "production";
    delete env.MCP_TOKEN_SECRET;
    env.CRON_SECRET = "cron-secret";
    expect(() => mcpTokenSecret()).toThrow(ConfigError);
  });

  it("returns MCP_TOKEN_SECRET in production when set", () => {
    env.NODE_ENV = "production";
    env.MCP_TOKEN_SECRET = "mcp-secret";
    expect(mcpTokenSecret()).toBe("mcp-secret");
  });

  it("leaves MCP_TOKEN_SECRET optional outside production", () => {
    for (const mode of ["test", "development"]) {
      env.NODE_ENV = mode;
      delete env.MCP_TOKEN_SECRET;
      expect(mcpTokenSecret()).toBeUndefined();
      env.MCP_TOKEN_SECRET = "";
      expect(mcpTokenSecret()).toBeUndefined();
      env.MCP_TOKEN_SECRET = "mcp-secret";
      expect(mcpTokenSecret()).toBe("mcp-secret");
    }
  });

  it("leaves OAUTH_STATE_SECRET optional everywhere, production included", () => {
    for (const mode of ["test", "production"]) {
      env.NODE_ENV = mode;
      delete env.OAUTH_STATE_SECRET;
      expect(oauthStateSecret()).toBeUndefined();
      env.OAUTH_STATE_SECRET = "";
      expect(oauthStateSecret()).toBeUndefined();
      env.OAUTH_STATE_SECRET = "state-secret";
      expect(oauthStateSecret()).toBe("state-secret");
    }
  });

  it("requires CRON_SECRET", () => {
    delete env.CRON_SECRET;
    expect(() => cronSecret()).toThrow("CRON_SECRET is not configured");
    env.CRON_SECRET = "cron-secret";
    expect(cronSecret()).toBe("cron-secret");
  });
});
