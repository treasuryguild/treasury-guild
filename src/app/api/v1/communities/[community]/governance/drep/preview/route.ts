// Preview a DRep draft; writes nothing (POST /api/v1/drafts/confirm carries it out).
import { v1PostRoute } from "@/lib/api/route";
import { previewDrep } from "@/lib/api/v1/governanceWrite";

export const POST = v1PostRoute<{ community: string }>(previewDrep);
