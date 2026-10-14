// Connect the Zoom account that hosts the community's calls (admins). GET
// sends the admin to Zoom's consent screen; DELETE forgets the connection and
// its tokens. See zoomHostLink in lib/oauth/hostProviders.ts.
import { hostConnectRoute, hostDisconnectRoute } from "@/lib/oauth/hostLink";
import { zoomHostLink } from "@/lib/oauth/hostProviders";

export const GET = hostConnectRoute(zoomHostLink);
export const DELETE = hostDisconnectRoute(zoomHostLink);
