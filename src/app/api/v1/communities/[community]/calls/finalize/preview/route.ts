// Preview paying a call's attendance into tasks; writes nothing.
import { v1PostRoute } from "@/lib/api/route";
import { previewCallFinalize } from "@/lib/api/v1/callWrite";

export const POST = v1PostRoute<{ community: string }>(previewCallFinalize);
