// A community's tasks (?workgroup=&payState=&includeArchived=&limit=).
import { v1Route } from "@/lib/api/route";
import { listTasks } from "@/lib/api/v1/tasks";

export const GET = v1Route<{ community: string }>(listTasks);
