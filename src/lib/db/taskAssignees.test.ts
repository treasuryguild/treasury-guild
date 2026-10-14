import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";
import { PgCode } from "@/lib/constants";
import { ConflictError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));

import { replaceTaskAssignees, type AssigneeWrite } from "./taskAssignees";

const TASK = "30000000-0000-4000-8000-000000000001";
const NEXT: AssigneeWrite[] = [
  { source: "github", id: "50000000-0000-4000-8000-000000000001", wallet: "addr_test1gh" },
  { source: "manual", wallet: "addr_test1manual" },
];
const ROWS = [{ id: "r-1", task_id: TASK, source: "github", gh_login: "octo", wallet_address: "addr_test1gh", position: 0 }];

beforeEach(() => {
  vi.resetAllMocks();
});

describe("replaceTaskAssignees", () => {
  it("writes the whole set in one replace_task_assignees step, then reads the rows back in order", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const order = vi.fn(async () => ({ data: ROWS, error: null }));
    const eq = vi.fn(() => ({ order }));
    mocks.from.mockReturnValue({ select: () => ({ eq }) });
    expect(await replaceTaskAssignees(TASK, NEXT)).toEqual(ROWS);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("replace_task_assignees", { p_task_id: TASK, p_assignees: NEXT });
    expect(mocks.from).toHaveBeenCalledWith("task_assignees");
    expect(eq).toHaveBeenCalledWith("task_id", TASK);
    expect(order).toHaveBeenCalledWith("position");
  });

  it("refuses with 409 once the task is queued or paid, without reading the rows", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: new PostgrestError({ message: "Assignees are locked once a payout has been queued or paid", code: PgCode.CheckViolation, details: "", hint: "" }),
    });
    await expect(replaceTaskAssignees(TASK, NEXT)).rejects.toThrow(new ConflictError("Assignees are locked once a payout has been queued or paid"));
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
