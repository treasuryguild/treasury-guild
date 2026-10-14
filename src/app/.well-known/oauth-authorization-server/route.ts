// RFC 8414 Authorization Server Metadata of the agent API.
import { oauthPreflight, oauthRoute } from "@/lib/api/route";
import { authorizationServerMetadata } from "@/lib/oauthServer/config";

export const GET = oauthRoute(async () => authorizationServerMetadata());
export const OPTIONS = oauthPreflight;
