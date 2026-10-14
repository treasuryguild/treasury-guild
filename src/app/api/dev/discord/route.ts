// Developer tool: post a fixture Discord payout message to a webhook so the
// format can be checked in a real channel. DEV_WALLETS only (devRoute).
import { devRoute, parseJson } from "@/lib/api/route";
import { devDiscordSendSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { buildScenario } from "@/lib/discord/fixtures";
import { DiscordWebhookError, postDiscordWebhook } from "@/lib/discord/webhook";
import { BadRequestError } from "@/lib/errors";

export const POST = devRoute(async (req) => {
  const { url, scenario } = await parseJson(req, devDiscordSendSchema);
  try {
    await postDiscordWebhook(url, buildScenario(scenario));
  } catch (err) {
    if (err instanceof DiscordWebhookError) throw new BadRequestError(err.message);
    throw err;
  }
  return { ok: true } satisfies OkResponse;
});
