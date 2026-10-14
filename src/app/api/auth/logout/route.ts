import { NextResponse } from "next/server";
import { publicRoute } from "@/lib/api/route";
import { SESSION_COOKIE } from "@/lib/auth/jwt";

export const POST = publicRoute(async () => {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
});
