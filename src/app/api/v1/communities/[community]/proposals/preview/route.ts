// Preview a proposal the caller would make; writes nothing and returns a draft token.
import { v1PostRoute } from "@/lib/api/route";
import { previewProposal } from "@/lib/api/v1/proposalWrite";

export const POST = v1PostRoute<{ community: string }>(previewProposal);
