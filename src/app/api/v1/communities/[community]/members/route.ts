// A community's members: name, role, wallet, GitHub login, workgroups led.
import { v1Route } from "@/lib/api/route";
import { listMembers } from "@/lib/api/v1/members";

export const GET = v1Route<{ community: string }>(listMembers);
