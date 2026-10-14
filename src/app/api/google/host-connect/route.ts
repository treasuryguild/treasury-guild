// Connect the Google account that organises the community's Meet calls
// (admins). GET sends the admin to Google's consent screen; DELETE forgets the
// connection, deletes its tokens and revokes the grant at Google. See
// googleHostLink in lib/oauth/hostProviders.ts.
import { hostConnectRoute, hostDisconnectRoute } from "@/lib/oauth/hostLink";
import { googleHostLink } from "@/lib/oauth/hostProviders";

export const GET = hostConnectRoute(googleHostLink);
export const DELETE = hostDisconnectRoute(googleHostLink);
