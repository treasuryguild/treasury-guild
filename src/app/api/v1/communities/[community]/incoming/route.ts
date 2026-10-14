// What arrived in a community's treasuries (?limit=).
import { v1Route } from "@/lib/api/route";
import { listIncoming } from "@/lib/api/v1/incoming";

export const GET = v1Route<{ community: string }>(listIncoming);
