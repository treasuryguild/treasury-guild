import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_SCOPES } from "@/lib/mcp/scopes";
import {
  authorizationServerMetadata,
  issuerOrigin,
  MCP_RESOURCE_PATH,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  resourceUrl,
} from "./config";

const ORIGIN = "https://vault.example";
const savedAppUrl = process.env.APP_URL;

beforeEach(() => {
  process.env.APP_URL = ORIGIN;
});
afterEach(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

describe("issuerOrigin", () => {
  it("is APP_URL", () => {
    expect(issuerOrigin()).toBe(ORIGIN);
  });

  it("drops trailing slashes", () => {
    process.env.APP_URL = `${ORIGIN}/`;
    expect(issuerOrigin()).toBe(ORIGIN);
    process.env.APP_URL = `${ORIGIN}///`;
    expect(issuerOrigin()).toBe(ORIGIN);
  });

  it("falls back to localhost when APP_URL is unset", () => {
    delete process.env.APP_URL;
    expect(issuerOrigin()).toBe("http://localhost:3000");
  });

  it("is read per call, not cached at import", () => {
    process.env.APP_URL = "https://other.example";
    expect(issuerOrigin()).toBe("https://other.example");
    expect(resourceUrl()).toBe("https://other.example/api/mcp");
  });
});

describe("resourceUrl / protectedResourceMetadataUrl", () => {
  it("name the MCP endpoint under the issuer", () => {
    expect(MCP_RESOURCE_PATH).toBe("/api/mcp");
    expect(resourceUrl()).toBe(`${ORIGIN}/api/mcp`);
    expect(protectedResourceMetadataUrl()).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`);
  });

  it("never double the slash of an APP_URL ending in one", () => {
    process.env.APP_URL = `${ORIGIN}/`;
    expect(resourceUrl()).toBe(`${ORIGIN}/api/mcp`);
    expect(protectedResourceMetadataUrl()).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`);
  });
});

describe("authorizationServerMetadata", () => {
  it("puts every endpoint under the issuer", () => {
    const meta = authorizationServerMetadata();
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.authorization_endpoint).toBe(`${ORIGIN}/api/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/api/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${ORIGIN}/api/oauth/register`);
    expect(meta.service_documentation).toBe(`${ORIGIN}/docs/ai-assistants`);
  });

  it("advertises the code flow with PKCE S256 only", () => {
    const meta = authorizationServerMetadata();
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("advertises what makes clients choose metadata documents", () => {
    const meta = authorizationServerMetadata();
    expect(meta.token_endpoint_auth_methods_supported).toContain("none");
    expect(meta.token_endpoint_auth_methods_supported).toContain("client_secret_post");
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
  });

  it("lists every scope, as a copy", () => {
    const meta = authorizationServerMetadata();
    expect(meta.scopes_supported).toEqual([...API_SCOPES]);
    expect(meta.scopes_supported).not.toBe(API_SCOPES);
  });
});

describe("protectedResourceMetadata", () => {
  it("binds the resource to this issuer as its one authorization server", () => {
    const meta = protectedResourceMetadata();
    expect(meta.resource).toBe(`${ORIGIN}/api/mcp`);
    expect(meta.resource).toBe(resourceUrl());
    expect(meta.authorization_servers).toEqual([ORIGIN]);
    expect(meta.authorization_servers).toEqual([authorizationServerMetadata().issuer]);
    expect(meta.scopes_supported).toEqual([...API_SCOPES]);
    expect(meta.bearer_methods_supported).toEqual(["header"]);
    expect(meta.resource_name).toBe("Guild Vault");
    expect(meta.resource_documentation).toBe(`${ORIGIN}/docs/ai-assistants`);
  });
});
