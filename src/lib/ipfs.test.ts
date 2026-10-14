import { describe, expect, it } from "vitest";
import { ipfsToHttp, ipfsUrl } from "./ipfs";

const GATEWAY = "gateway.pinata.cloud";
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

describe("ipfsUrl", () => {
  it("builds the gateway URL of a cid", () => {
    expect(ipfsUrl(GATEWAY, CID)).toBe(`https://${GATEWAY}/ipfs/${CID}`);
  });
});

describe("ipfsToHttp", () => {
  it("maps ipfs://<cid> to the gateway", () => {
    expect(ipfsToHttp(`ipfs://${CID}`, GATEWAY)).toBe(`https://${GATEWAY}/ipfs/${CID}`);
  });

  it("maps the ipfs://ipfs/<cid> form to the same URL", () => {
    expect(ipfsToHttp(`ipfs://ipfs/${CID}`, GATEWAY)).toBe(`https://${GATEWAY}/ipfs/${CID}`);
  });

  it("keeps a path after the cid", () => {
    expect(ipfsToHttp(`ipfs://${CID}/images/1.png`, GATEWAY)).toBe(`https://${GATEWAY}/ipfs/${CID}/images/1.png`);
  });

  it("strips only a leading ipfs/ segment", () => {
    expect(ipfsToHttp(`ipfs://${CID}/ipfs/x`, GATEWAY)).toBe(`https://${GATEWAY}/ipfs/${CID}/ipfs/x`);
  });

  it("passes http and https through unchanged", () => {
    expect(ipfsToHttp("https://example.com/a.png", GATEWAY)).toBe("https://example.com/a.png");
    expect(ipfsToHttp("http://example.com/a.png", GATEWAY)).toBe("http://example.com/a.png");
  });

  it("is null for anything else", () => {
    expect(ipfsToHttp("", GATEWAY)).toBeNull();
    expect(ipfsToHttp(CID, GATEWAY)).toBeNull();
    expect(ipfsToHttp("ar://abc", GATEWAY)).toBeNull();
    expect(ipfsToHttp("data:image/png;base64,AAAA", GATEWAY)).toBeNull();
    expect(ipfsToHttp("javascript:alert(1)", GATEWAY)).toBeNull();
    expect(ipfsToHttp("IPFS://" + CID, GATEWAY)).toBeNull();
    expect(ipfsToHttp(" https://example.com", GATEWAY)).toBeNull();
  });
});
