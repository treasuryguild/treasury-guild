import { describe, expect, it } from "vitest";
import { buildCopyGraceEmbed, buildStaleAnchorsEmbed } from "./anchorMessage";

describe("buildStaleAnchorsEmbed", () => {
  it("lists due steps and points at the proposals page", () => {
    const payload = buildStaleAnchorsEmbed({
      communityName: "Guild",
      proposalsUrl: "https://app.example/c/guild/proposals",
      lines: [
        { number: 3, title: "Budget Q4", step: "proposed" },
        { number: 5, title: "Hire", step: "closed" },
      ],
    });
    const embed = payload.embeds[0]!;
    expect(embed.title).toBe("On-chain anchors waiting");
    expect(embed.url).toBe("https://app.example/c/guild/proposals");
    expect(embed.description).toContain("Guild");
    expect(embed.fields?.[0]?.value).toContain("#3");
    expect(embed.fields?.[0]?.value).toContain("proposed");
    expect(embed.fields?.[0]?.value).toContain("#5");
  });
});

describe("buildCopyGraceEmbed", () => {
  it("names the proposal and the grace deadline", () => {
    const payload = buildCopyGraceEmbed({
      communityName: "Guild",
      number: 7,
      title: "Raise the quorum",
      proposalUrl: "https://app.example/c/guild/proposals/p-7",
      graceEndsAt: "2026-10-02T00:00:00.000Z",
    });
    const embed = payload.embeds[0]!;
    expect(embed.title).toBe("Tally copy needed · Proposal #7");
    expect(embed.url).toContain("p-7");
    expect(embed.description).toContain("Raise the quorum");
    expect(embed.fields?.[0]?.value).toMatch(/^<t:\d+:R>$/);
  });
});
