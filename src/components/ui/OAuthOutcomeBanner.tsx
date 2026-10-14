export type OAuthOutcomeMessages = Partial<Record<"connected" | "taken" | "cancelled" | "error", string>>;

const TONES: Record<string, string> = {
  connected: "text-green-400",
  taken: "text-amber-500",
  cancelled: "text-zinc-400",
  error: "text-red-400",
};

/** The standard lines for connecting a `name` account; `messages` overrides any of them. */
function outcomeMessages(name: string, messages: OAuthOutcomeMessages): OAuthOutcomeMessages {
  return {
    connected: `${name} connected.`,
    taken: `That ${name} account is already linked to another wallet. Disconnect it there first.`,
    cancelled: `${name} connection cancelled.`,
    error: `${name} connection failed. Please try again.`,
    ...messages,
  };
}

/** What an OAuth round trip ended with; a failure shows its reason code. Nothing for no or unknown outcome. */
export function OAuthOutcomeBanner({ name, outcome, reason, messages = {} }: {
  name: string;
  outcome: string | null;
  reason: string | null;
  messages?: OAuthOutcomeMessages;
}) {
  const text = outcome ? outcomeMessages(name, messages)[outcome as keyof OAuthOutcomeMessages] : undefined;
  const tone = outcome ? TONES[outcome] : undefined;
  if (!text || !tone) return null;
  return (
    <p className={`mt-3 text-sm ${tone}`}>
      {text}
      {outcome === "error" && reason && <span className="ml-2 font-mono text-xs text-zinc-500">({reason})</span>}
    </p>
  );
}
