// The IPFS gateway host used for image previews (public, non-secret).
import { publicRoute } from "@/lib/api/route";
import type { IpfsGatewayResponse } from "@/lib/api/types";
import { pinataGateway } from "@/lib/env.server";

export const GET = publicRoute(
  async () => ({ gateway: pinataGateway() }) satisfies IpfsGatewayResponse,
);
