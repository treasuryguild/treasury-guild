import { cronRoute } from "@/lib/api/route";
import { runGithubSyncSweep } from "@/lib/github/sweep";

export const POST = cronRoute(async () => runGithubSyncSweep());
