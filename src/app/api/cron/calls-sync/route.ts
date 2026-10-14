import { cronRoute } from "@/lib/api/route";
import { runCallsSync } from "@/lib/calls/capture";

export const POST = cronRoute(async () => runCallsSync());
