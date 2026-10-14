// Zoom redirects here after an admin approved the host account:
// GET /api/zoom/oauth-callback?code=…&state=<signed {wallet, communityId}>.
// Every outcome is a redirect with ?zoom=<outcome>.
import { hostCallbackRoute } from "@/lib/oauth/hostLink";
import { zoomHostLink } from "@/lib/oauth/hostProviders";

export const GET = hostCallbackRoute(zoomHostLink);
