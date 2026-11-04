// Preview a funding-schedule import; writes nothing (POST /api/v1/drafts/confirm carries it out).
import { v1PostRoute } from "@/lib/api/route";
import { previewFundingSchedule } from "@/lib/api/v1/fundingImport";

export const POST = v1PostRoute<{ community: string }>(previewFundingSchedule);
