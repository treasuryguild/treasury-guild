// A community's workgroups with their leads and treasury (?includeArchived=).
import { v1Route } from "@/lib/api/route";
import { listWorkgroups } from "@/lib/api/v1/workgroups";

export const GET = v1Route<{ community: string }>(listWorkgroups);
