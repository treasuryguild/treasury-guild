// Discord redirects here after the user approves the account link.
// See src/lib/oauth/identityLink.ts.
import { IdentityProvider } from "@/lib/constants";
import { identityCallbackRoute } from "@/lib/oauth/identityLink";

export const GET = identityCallbackRoute(IdentityProvider.Discord);
