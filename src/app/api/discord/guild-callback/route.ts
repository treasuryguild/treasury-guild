// Discord redirects here after an admin added the capture bot to a server:
// GET /api/discord/guild-callback?code=…&state=<signed {wallet, communityId}>.
// Every outcome is a redirect with ?discord_server=<outcome>. The server id
// comes from Discord's token response, never from the query string.
import { hostCallbackRoute } from "@/lib/oauth/hostLink";
import { discordGuildLink } from "@/lib/oauth/hostProviders";

export const GET = hostCallbackRoute(discordGuildLink);
