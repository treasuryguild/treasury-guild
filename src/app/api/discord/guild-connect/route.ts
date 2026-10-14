// Connect the community's Discord server for call capture (admins). GET sends
// the admin to Discord to add the bot to a server they manage; DELETE forgets
// the connection and takes the bot out of the server when no other community
// uses it. See discordGuildLink in lib/oauth/hostProviders.ts.
import { hostConnectRoute, hostDisconnectRoute } from "@/lib/oauth/hostLink";
import { discordGuildLink } from "@/lib/oauth/hostProviders";

export const GET = hostConnectRoute(discordGuildLink);
export const DELETE = hostDisconnectRoute(discordGuildLink);
