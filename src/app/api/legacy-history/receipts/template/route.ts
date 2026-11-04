// Download the receipts CSV template.
import { sessionRoute } from "@/lib/api/route";
import {
  LEGACY_RECEIPTS_CSV_TEMPLATE, LEGACY_RECEIPTS_CSV_TEMPLATE_NAME,
} from "@/lib/legacyHistory/receiptTemplate";

export const GET = sessionRoute(async () => {
  return {
    fileName: LEGACY_RECEIPTS_CSV_TEMPLATE_NAME,
    csv: LEGACY_RECEIPTS_CSV_TEMPLATE,
  };
});
