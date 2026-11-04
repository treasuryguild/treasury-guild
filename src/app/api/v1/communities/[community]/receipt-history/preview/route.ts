// Preview a previous-wallet receipts import; writes nothing (POST /api/v1/drafts/confirm carries it out).
import { v1PostRoute } from "@/lib/api/route";
import { previewReceiptHistory } from "@/lib/api/v1/receiptImport";

export const POST = v1PostRoute<{ community: string }>(previewReceiptHistory);
