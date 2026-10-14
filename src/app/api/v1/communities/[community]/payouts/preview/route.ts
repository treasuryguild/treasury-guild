// Preview a payout draft; writes nothing (POST /api/v1/drafts/confirm carries it out).
import { v1PostRoute } from "@/lib/api/route";
import { previewPayout } from "@/lib/api/v1/payoutWrite";

export const POST = v1PostRoute<{ community: string }>(previewPayout);
