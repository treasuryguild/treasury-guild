// The communities the caller belongs to, with their role in each.
import { v1Route } from "@/lib/api/route";
import { listCommunities } from "@/lib/api/v1/communities";

export const GET = v1Route(listCommunities);
