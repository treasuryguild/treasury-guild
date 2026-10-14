// Link (GET) or unlink (DELETE) the session wallet's Discord account.
// See src/lib/oauth/identityLink.ts.
import { IdentityProvider } from "@/lib/constants";
import { identityConnectRoute, identityDisconnectRoute } from "@/lib/oauth/identityLink";

export const GET = identityConnectRoute(IdentityProvider.Discord);
export const DELETE = identityDisconnectRoute(IdentityProvider.Discord);
