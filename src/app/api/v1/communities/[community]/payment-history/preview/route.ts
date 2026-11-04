// Preview a payment-history import; writes nothing (POST /api/v1/drafts/confirm carries it out).
import { v1PostRoute } from "@/lib/api/route";
import { previewPaymentHistory } from "@/lib/api/v1/historyImport";

export const POST = v1PostRoute<{ community: string }>(previewPaymentHistory);
