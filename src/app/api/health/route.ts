import { publicRoute } from "@/lib/api/route";
import { appNetwork, networkName } from "@/lib/config";

export const GET = publicRoute(async () => ({
  ok: true,
  network: networkName(appNetwork()),
}));
