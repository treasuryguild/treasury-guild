// Preview creating or editing an app-board task; writes nothing.
import { v1PostRoute } from "@/lib/api/route";
import { previewTaskSave } from "@/lib/api/v1/taskWrite";

export const POST = v1PostRoute<{ community: string }>(previewTaskSave);
