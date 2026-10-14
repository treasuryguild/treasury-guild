// A community's transactions (?treasury=&kind=&state=&limit=).
import { v1Route } from "@/lib/api/route";
import { listTransactions } from "@/lib/api/v1/transactions";

export const GET = v1Route<{ community: string }>(listTransactions);
