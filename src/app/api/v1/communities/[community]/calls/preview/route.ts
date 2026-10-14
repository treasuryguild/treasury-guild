// Preview creating a rewarded call; writes nothing.
import { v1PostRoute } from "@/lib/api/route";
import { previewCallCreate } from "@/lib/api/v1/callWrite";

export const POST = v1PostRoute<{ community: string }>(previewCallCreate);
