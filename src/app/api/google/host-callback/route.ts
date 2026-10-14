// Google redirects here after an admin approved the meeting host account:
// GET /api/google/host-callback?code=…&state=<signed {wallet, communityId}>.
// Every outcome is a redirect with ?google_host=<outcome>.
import { hostCallbackRoute } from "@/lib/oauth/hostLink";
import { googleHostLink } from "@/lib/oauth/hostProviders";

export const GET = hostCallbackRoute(googleHostLink);
