// RFC 9728 Protected Resource Metadata of /api/mcp (the path-aware form the
// 401 challenge names).
import { oauthPreflight, oauthRoute } from "@/lib/api/route";
import { protectedResourceMetadata } from "@/lib/oauthServer/config";

export const GET = oauthRoute(async () => protectedResourceMetadata());
export const OPTIONS = oauthPreflight;
