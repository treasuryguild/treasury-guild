// Mints a short-lived Pinata presigned upload URL so the browser can push a
// token image straight to IPFS. The Pinata JWT never leaves the server and
// the image never passes through a Netlify function (6 MB body cap).
import { PinataSDK } from "pinata";
import { parseJson, sessionRoute } from "@/lib/api/route";
import { ipfsSignUploadSchema, MAX_IMAGE_BYTES } from "@/lib/api/schemas";
import type { IpfsSignUploadResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import { communitySlug } from "@/lib/db/communities";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { pinataGateway, pinataJwt } from "@/lib/env.server";

const URL_TTL_SECONDS = 120;

export const POST = sessionRoute(async (req, { session }) => {
  // `size` is validated against MAX_IMAGE_BYTES by the schema; it is not used
  // as the presigned cap because Pinata measures the whole multipart body
  // (file + `network`/`name` fields + boundaries), so an exact-size cap
  // rejects every upload with "exceeds this presigned URL's maximum file size".
  const { communityId, name, mimeType } = await parseJson(
    req,
    ipfsSignUploadSchema,
  );
  await requireMember(communityId, session.wallet);
  await enforceRateLimit("ipfsUpload", session.wallet);
  const slug = await communitySlug(communityId);

  const pinata = new PinataSDK({
    pinataJwt: pinataJwt(),
    pinataGateway: pinataGateway(),
  });
  const safeName = (name ?? "image").replace(/[^\w.\-]+/g, "_").slice(0, 100);
  const url = await pinata.upload.public.createSignedURL({
    expires: URL_TTL_SECONDS,
    name: `${slug}/${safeName}`,
    mimeTypes: [mimeType],
    maxFileSize: MAX_IMAGE_BYTES,
    keyvalues: {
      app: "treasury-guild",
      community: slug,
      uploader: session.wallet,
    },
  });

  return { url, gateway: pinataGateway() } satisfies IpfsSignUploadResponse;
});
