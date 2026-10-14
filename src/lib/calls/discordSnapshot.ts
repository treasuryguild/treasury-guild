// Who is in a Discord voice channel, from the guild state the gateway sends
// on connect (GUILD_CREATE). Pure: the gateway client fetches, this reads.

/** The parts of a GUILD_CREATE payload capture uses. */
export interface GatewayGuild {
  id: string;
  name?: string;
  /** Everyone currently in any voice channel of the guild. */
  voice_states?: { user_id: string; channel_id: string | null }[];
  /** Without privileged intents: the bot itself and the users in voice channels. */
  members?: {
    user?: { id: string; username?: string; global_name?: string | null; bot?: boolean };
    nick?: string | null;
  }[];
}

export interface PresentUser {
  /** Discord user id. */
  id: string;
  /** Server nickname, else display name, else username; "" when Discord sent none. */
  name: string;
}

/** The people (never bots) in one voice channel, each once. */
export function presentInChannel(guild: GatewayGuild, channelId: string): PresentUser[] {
  const members = new Map(
    (guild.members ?? []).flatMap((m) => (m.user ? [[m.user.id, m] as const] : [])),
  );
  const present = new Map<string, PresentUser>();
  for (const state of guild.voice_states ?? []) {
    if (state.channel_id !== channelId || present.has(state.user_id)) continue;
    const member = members.get(state.user_id);
    if (member?.user?.bot) continue;
    present.set(state.user_id, {
      id: state.user_id,
      name: member?.nick || member?.user?.global_name || member?.user?.username || "",
    });
  }
  return [...present.values()];
}
