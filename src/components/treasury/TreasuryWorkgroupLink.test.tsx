// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CreateTreasuryResponse } from "@/lib/api/types";
import { TreasuryCreatedNotice, TreasuryLinkField } from "./TreasuryWorkgroupLink";

afterEach(cleanup);

const treasury = { id: "treasury-1", name: "Dev wallet" } as CreateTreasuryResponse["treasury"];
const notice = (result: Pick<CreateTreasuryResponse, "link" | "linkError">) =>
  render(<TreasuryCreatedNotice slug="guild" workgroupName="Dev" result={{ treasury, ...result }} />);

describe("treasury workgroup link", () => {
  it("defaults to a community treasury and reports the chosen workgroup", async () => {
    const onChange = vi.fn();
    render(<TreasuryLinkField workgroups={[{ id: "group-1", name: "Dev" }]} value="" onChange={onChange} />);
    const select = screen.getByLabelText("Used for") as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe("Community treasury");
    await userEvent.setup().selectOptions(select, "group-1");
    expect(onChange).toHaveBeenCalledWith("group-1");
  });

  it("says which period the link starts in", () => {
    notice({ link: { workgroupId: "group-1", startsOn: "2026-09-01", effective: "current" }, linkError: null });
    expect(screen.getByText("Dev is paid from this treasury from Sep 2026.")).toBeTruthy();
    cleanup();
    notice({ link: { workgroupId: "group-1", startsOn: "2026-10-01", effective: "next" }, linkError: null });
    expect(screen.getByText(/already has payouts from another wallet this period.*from Oct 2026/)).toBeTruthy();
  });

  it("explains a refused link and still leads to the treasury", () => {
    notice({ link: null, linkError: "A later wallet change is already scheduled" });
    expect(screen.getByText(/was not linked to Dev: A later wallet change is already scheduled/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to treasury" }).getAttribute("href")).toBe("/c/guild/treasury");
  });
});
