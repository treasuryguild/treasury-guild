// Validation of API input with zod, shared by the route wrappers
// (src/lib/api/route.ts) and the agent API endpoints (src/lib/api/v1), so a
// bad request reads the same over REST and over MCP.
import type { z } from "zod";
import { BadRequestError } from "@/lib/errors";

function issueMessage(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join(".");
  if (/received undefined$/.test(issue.message)) {
    return path ? `${path} is required` : "Request body is required";
  }
  // refine()/custom messages are written for users — keep them verbatim.
  if (issue.code === "custom") return issue.message;
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Parse + validate `input`; 400 with the first issue otherwise. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new BadRequestError(first ? issueMessage(first) : "Invalid request");
}
