// Outside funders: planned vs received per source and commitment.
import { v1Route } from "@/lib/api/route";
import { fundingSummary } from "@/lib/api/v1/funding";

export const GET = v1Route<{ community: string }>(fundingSummary);
