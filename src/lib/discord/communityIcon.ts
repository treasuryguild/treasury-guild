// Resolve the HTTPS URL Discord should load for a community's embed author
// icon. Falls back to the app logo when the community has no avatar.
import "server-only";

import { pinataGateway } from "@/lib/env.server";
import { ipfsUrl } from "@/lib/ipfs";
import { AVATAR_PATH } from "./payoutMessage";

export function communityIconUrl(
  avatarCid: string | null | undefined,
  appBase: string,
): string {
  if (avatarCid) return ipfsUrl(pinataGateway(), avatarCid);
  return `${appBase}${AVATAR_PATH}`;
}
