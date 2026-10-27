// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GithubBountyFieldPicker } from "./GithubBountyFieldPicker";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({
  apiFetch: mocks.apiFetch,
  describeApiError: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

const TASK = "20000000-0000-4000-8000-000000000002";
const TREASURY = "20000000-0000-4000-8000-000000000003";
const UNIT = "a".repeat(56) + "bb";

afterEach(cleanup);

describe("GithubBountyFieldPicker", () => {
  it("adds an existing project field", async () => {
    const onAddField = vi.fn();
    const user = userEvent.setup();
    render(
      <GithubBountyFieldPicker
        target={{ taskId: TASK }}
        numberFieldNames={["ADA", "SIGN"]}
        usedFieldNames={new Set(["ada"])}
        walletTokens={[]}
        onAddField={onAddField}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Add bounty field"), "SIGN");
    expect(onAddField).toHaveBeenCalledWith("SIGN");
  });

  it("creates a field from a wallet token after confirm", async () => {
    mocks.apiFetch.mockResolvedValue({
      fieldName: "HOSKY",
      created: true,
      unit: UNIT,
    });
    const onAddField = vi.fn();
    const user = userEvent.setup();
    render(
      <GithubBountyFieldPicker
        target={{ taskId: TASK }}
        numberFieldNames={["ADA"]}
        usedFieldNames={new Set(["ada"])}
        walletTokens={[
          { unit: UNIT, ticker: "HOSKY", decimals: 0, treasuryId: TREASURY },
        ]}
        onAddField={onAddField}
      />,
    );
    await user.selectOptions(
      screen.getByLabelText("Add bounty field"),
      "__create__",
    );
    expect(screen.getByText(/adds a Number field/i)).toBeTruthy();
    await user.selectOptions(
      screen.getByLabelText("Wallet token for bounty field"),
      `${TREASURY}:${UNIT}`,
    );
    expect(screen.getByLabelText("Bounty field name")).toHaveProperty("value", "HOSKY");
    await user.click(screen.getByRole("button", { name: "Create field" }));
    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/github/project-field", {
      body: {
        taskId: TASK,
        kind: "token",
        fieldName: "HOSKY",
        unit: UNIT,
        treasuryId: TREASURY,
      },
    });
    expect(onAddField).toHaveBeenCalledWith("HOSKY");
  });
});
