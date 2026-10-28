import { describe, expect, it } from "vitest";
import { SpendCheckMode } from "@/lib/governance/rules";
import { buildIntegrationsStatus, SetupItemId, type IntegrationsStatusInput } from "./status";

function base(over: Partial<IntegrationsStatusInput> = {}): IntegrationsStatusInput {
  return {
    discord: { serverConnected: false, serverLabel: null, channelId: null, lastError: null },
    treasuries: [],
    webhookTreasuryIds: [],
    rateConfigured: false,
    github: {
      installationCount: 0,
      linkedRepoCount: 0,
      workgroupsMissingRepo: 0,
      documentStore: null,
      documentArchiveRepoId: null,
    },
    calls: { zoomConnected: false, googleConnected: false, linkedMeetingCount: 0 },
    spendCheck: SpendCheckMode.Warn,
    anyKindEnabled: false,
    ...over,
  };
}

describe("buildIntegrationsStatus", () => {
  it("asks for a treasury when none exist", () => {
    const status = buildIntegrationsStatus(base());
    expect(status.treasuryCount).toBe(0);
    expect(status.checklist.map((c) => c.id)).toContain(SetupItemId.Treasury);
  });

  it("marks Discord channel incomplete only after the server is connected", () => {
    const without = buildIntegrationsStatus(base({
      discord: { serverConnected: false, serverLabel: null, channelId: null, lastError: null },
    }));
    expect(without.checklist.map((c) => c.id)).toContain(SetupItemId.DiscordServer);
    expect(without.checklist.map((c) => c.id)).not.toContain(SetupItemId.DiscordChannel);

    const withServer = buildIntegrationsStatus(base({
      discord: { serverConnected: true, serverLabel: "Guild", channelId: null, lastError: null },
    }));
    expect(withServer.checklist.map((c) => c.id)).toContain(SetupItemId.DiscordChannel);
    expect(withServer.checklist.map((c) => c.id)).not.toContain(SetupItemId.DiscordServer);
  });

  it("lists per-treasury webhook completeness and soft rate hint", () => {
    const status = buildIntegrationsStatus(base({
      treasuries: [
        { id: "t1", name: "Main" },
        { id: "t2", name: "Ops" },
      ],
      webhookTreasuryIds: ["t1"],
      rateConfigured: false,
    }));
    expect(status.payoutDiscord.treasuries).toEqual([
      { treasuryId: "t1", name: "Main", webhookConnected: true },
      { treasuryId: "t2", name: "Ops", webhookConnected: false },
    ]);
    expect(status.checklist.map((c) => c.id)).toContain(SetupItemId.PayoutWebhooks);
    expect(status.checklist.map((c) => c.id)).toContain(SetupItemId.PayoutRate);
  });

  it("does not nag about rate when no webhook exists", () => {
    const status = buildIntegrationsStatus(base({
      treasuries: [{ id: "t1", name: "Main" }],
      webhookTreasuryIds: [],
      rateConfigured: false,
    }));
    expect(status.checklist.map((c) => c.id)).not.toContain(SetupItemId.PayoutRate);
  });

  it("flags GitHub workgroups missing a linked repo", () => {
    const status = buildIntegrationsStatus(base({
      github: {
        installationCount: 1,
        linkedRepoCount: 0,
        workgroupsMissingRepo: 2,
        documentStore: null,
        documentArchiveRepoId: null,
      },
    }));
    expect(status.github.workgroupsMissingRepo).toBe(2);
    expect(status.checklist.find((c) => c.id === SetupItemId.Github)?.label)
      .toMatch(/2 GitHub workgroups/);
  });

  it("treats GitHub archive as ready only when a repo is chosen", () => {
    expect(buildIntegrationsStatus(base({
      github: {
        installationCount: 1, linkedRepoCount: 1, workgroupsMissingRepo: 0,
        documentStore: "github", documentArchiveRepoId: null,
      },
    })).github.archiveReady).toBe(false);
    expect(buildIntegrationsStatus(base({
      github: {
        installationCount: 1, linkedRepoCount: 1, workgroupsMissingRepo: 0,
        documentStore: "github", documentArchiveRepoId: 42,
      },
    })).github.archiveReady).toBe(true);
    expect(buildIntegrationsStatus(base({
      github: {
        installationCount: 0, linkedRepoCount: 0, workgroupsMissingRepo: 0,
        documentStore: "ipfs", documentArchiveRepoId: null,
      },
    })).github.archiveReady).toBe(true);
  });

  it("suggests linked meetings only after a call host is connected", () => {
    const before = buildIntegrationsStatus(base());
    expect(before.checklist.map((c) => c.id)).toContain(SetupItemId.CallPlatform);
    expect(before.checklist.map((c) => c.id)).not.toContain(SetupItemId.LinkedMeetings);

    const after = buildIntegrationsStatus(base({
      calls: { zoomConnected: true, googleConnected: false, linkedMeetingCount: 0 },
    }));
    expect(after.checklist.map((c) => c.id)).toContain(SetupItemId.LinkedMeetings);
    expect(after.checklist.map((c) => c.id)).not.toContain(SetupItemId.CallPlatform);
  });

  it("soft-suggests tally publish when a kind is on and store is off", () => {
    const status = buildIntegrationsStatus(base({ anyKindEnabled: true }));
    expect(status.checklist.map((c) => c.id)).toContain(SetupItemId.TallyPublish);
    expect(status.checklist.find((c) => c.id === SetupItemId.TallyPublish)?.soft).toBe(true);
  });
});
