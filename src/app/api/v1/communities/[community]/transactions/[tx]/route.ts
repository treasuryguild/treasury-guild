// One transaction by id or on-chain hash: signatures, what it pays, its on-chain record.
import { v1Route } from "@/lib/api/route";
import { transactionDetail } from "@/lib/api/v1/transactions";

export const GET = v1Route<{ community: string; tx: string }>(transactionDetail);
