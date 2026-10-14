// One proposal by number: full text, timeline, ballots once visible, frozen tally.
import { v1Route } from "@/lib/api/route";
import { proposalDetail } from "@/lib/api/v1/proposals";

export const GET = v1Route<{ community: string; proposal: string }>(proposalDetail);
