// Create the proposal a preview described, from its draft token only.
import { v1PostRoute } from "@/lib/api/route";
import { createProposalFromDraft } from "@/lib/api/v1/proposalWrite";

export const POST = v1PostRoute<{ community: string }>(createProposalFromDraft);
