// Pending transactions, across the caller's communities, that wait on the caller's signature.
import { v1Route } from "@/lib/api/route";
import { signingQueue } from "@/lib/api/v1/signing";

export const GET = v1Route(signingQueue);
