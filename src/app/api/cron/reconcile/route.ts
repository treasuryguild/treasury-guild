import { cronRoute } from "@/lib/api/route";
import { runReconcileSweep } from "@/lib/reconciliation/sweep";

export const POST = cronRoute(async () => runReconcileSweep());
