// Carry out a previewed write from its draft token (MCP draft_confirm).
import { v1PostRoute } from "@/lib/api/route";
import { confirmDraft } from "@/lib/api/v1/drafts";

export const POST = v1PostRoute(confirmDraft);
