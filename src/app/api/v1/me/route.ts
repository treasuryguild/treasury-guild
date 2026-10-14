// The caller behind the request: wallet, OAuth client and granted scopes.
import { v1Route } from "@/lib/api/route";
import { whoami } from "@/lib/api/v1/communities";

export const GET = v1Route(whoami);
