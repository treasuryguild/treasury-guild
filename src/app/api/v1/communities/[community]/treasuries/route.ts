// A community's treasuries: signing rule, signers, balance (?balances=false skips the chain) and pending transaction.
import { v1Route } from "@/lib/api/route";
import { treasuryOverview } from "@/lib/api/v1/treasuries";

export const GET = v1Route<{ community: string }>(treasuryOverview);
