// RFC 9728 Protected Resource Metadata, root form: clients probe the
// path-aware form (…/api/mcp) first, then this one.
import { oauthPreflight, oauthRoute } from "@/lib/api/route";
import { protectedResourceMetadata } from "@/lib/oauthServer/config";

export const GET = oauthRoute(async () => protectedResourceMetadata());
export const OPTIONS = oauthPreflight;
