// Preview withdrawing the caller's own proposal; writes nothing.
import { v1PostRoute } from "@/lib/api/route";
import { previewProposalWithdraw } from "@/lib/api/v1/proposalWithdraw";

export const POST = v1PostRoute<{ community: string }>(previewProposalWithdraw);
