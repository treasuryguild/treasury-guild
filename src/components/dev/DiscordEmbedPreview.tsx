"use client";

// Approximation of how Discord renders an embed, so message changes can be
// eyeballed before posting. Supports the markdown the payout message uses:
// **bold**, `code`, [text](url) and line breaks. Not pixel-exact — Discord
// is the final judge; this catches shape and length problems early.
import type { ReactNode } from "react";
import type { DiscordEmbed, DiscordWebhookPayload } from "@/lib/discord/payoutMessage";
import { DISCORD_LIMITS, embedUsage } from "@/lib/discord/payoutMessage";

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

/** Render one line of Discord-flavoured markdown to React nodes. */
export function inlineMarkdown(line: string): ReactNode[] {
  return line.split(INLINE_RE).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-black/40 px-1 py-0.5 text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
          {inlineMarkdown(link[1]!)}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

const FENCE_RE = /```[\w-]*\n([\s\S]*?)\n```/g;

/** Discord-flavoured markdown: fenced code blocks, then inline markup per line. */
function Markdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  const pushLines = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line === "" && chunk === "") continue;
      parts.push(
        <span key={key++} className="block">
          {inlineMarkdown(line)}
        </span>,
      );
    }
  };
  for (const m of text.matchAll(FENCE_RE)) {
    const before = text.slice(last, m.index).replace(/\n$/, "");
    if (before) pushLines(before);
    parts.push(
      <pre
        key={key++}
        className="my-1 overflow-x-auto rounded bg-[#1e1f22] px-3 py-2 font-mono text-[13px] text-[#c9a86b]"
      >
        {m[1]}
      </pre>,
    );
    last = m.index + m[0].length;
  }
  const rest = text.slice(last).replace(/^\n/, "");
  if (rest) pushLines(rest);
  return <>{parts}</>;
}

function EmbedCard({ embed, username }: { embed: DiscordEmbed; username: string }) {
  const color = embed.color !== undefined ? `#${embed.color.toString(16).padStart(6, "0")}` : "#202225";
  return (
    <div className="rounded-lg bg-[#313338] p-3 text-[15px] leading-[1.375] text-[#dbdee1]">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500 text-sm font-bold text-white">
          {username.slice(0, 1)}
        </span>
        <span className="font-medium text-white">{username}</span>
        <span className="rounded bg-[#5865f2] px-1 text-[10px] font-semibold uppercase text-white">Bot</span>
      </div>
      <div className="ml-10 max-w-[520px] rounded border-l-4 bg-[#2b2d31] p-3" style={{ borderLeftColor: color }}>
        {embed.author && (
          <p className="mb-1 flex items-center gap-2 text-sm font-semibold text-white">
            {embed.author.icon_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={embed.author.icon_url} alt="" className="h-6 w-6 rounded-full bg-zinc-700 object-contain" />
            )}
            {embed.author.url ? (
              <a href={embed.author.url} target="_blank" rel="noreferrer" className="hover:underline">
                {embed.author.name}
              </a>
            ) : (
              embed.author.name
            )}
          </p>
        )}
        {embed.url ? (
          <a href={embed.url} target="_blank" rel="noreferrer" className="font-semibold text-sky-400 hover:underline">
            {embed.title}
          </a>
        ) : (
          <p className="font-semibold text-white">{embed.title}</p>
        )}
        {embed.description && (
          <div className="mt-2 text-sm">
            <Markdown text={embed.description} />
          </div>
        )}
        {embed.fields && embed.fields.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
            {embed.fields.map((f, i) => (
              <div key={i} className={f.inline ? "" : "col-span-3"}>
                <p className="text-xs font-semibold text-white">{f.name}</p>
                <div className="break-words">
                  <Markdown text={f.value} />
                </div>
              </div>
            ))}
          </div>
        )}
        {(embed.footer || embed.timestamp) && (
          <p className="mt-2 text-xs text-[#949ba4]">
            {embed.footer?.text}
            {embed.footer && embed.timestamp && " • "}
            {embed.timestamp && new Date(embed.timestamp).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}

export function DiscordEmbedPreview({ payload }: { payload: DiscordWebhookPayload }) {
  const usage = embedUsage(payload);
  const bad = usage.over.length > 0;
  return (
    <div>
      <div className="space-y-3">
        {payload.embeds.map((embed, i) => (
          <EmbedCard key={i} embed={embed} username={payload.username} />
        ))}
      </div>
      <p className={`mt-2 text-xs ${bad ? "text-red-400" : "text-zinc-500"}`}>
        description {usage.description.toLocaleString()} / {DISCORD_LIMITS.description.toLocaleString()} · embed{" "}
        {usage.total.toLocaleString()} / {DISCORD_LIMITS.embedTotal.toLocaleString()}
        {bad && ` · over: ${usage.over.join(", ")}`}
      </p>
    </div>
  );
}
