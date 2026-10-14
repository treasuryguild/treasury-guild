// A community's proposals (?state=open|closed|all&limit=).
import { v1Route } from "@/lib/api/route";
import { listProposals } from "@/lib/api/v1/proposals";

export const GET = v1Route<{ community: string }>(listProposals);
