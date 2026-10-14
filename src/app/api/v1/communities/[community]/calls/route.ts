// Rewarded calls and how their attendees stand (?state=&call=&limit=).
import { v1Route } from "@/lib/api/route";
import { listCalls } from "@/lib/api/v1/calls";

export const GET = v1Route<{ community: string }>(listCalls);
