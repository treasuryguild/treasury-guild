import type { NextConfig } from "next";
import createMDX from "@next/mdx";

const nextConfig: NextConfig = {
  // Mesh's serializers ship WASM that must load via node require on the
  // server, not through the bundler.
  serverExternalPackages: ["@meshsdk/core-csl", "@meshsdk/core-cst"],
  turbopack: {},
  // The Budget dashboard became the Dashboard; Discord embeds posted before
  // the rename still link to the old path.
  // Baseline hardening for every response. Framing is refused so a page that
  // asks a wallet to sign cannot be clickjacked. A script CSP is not set here:
  // Mesh loads WASM and Next inlines bootstrap scripts, which would need nonces.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/c/:slug/budget-dashboard", destination: "/c/:slug/dashboard", permanent: true },
    ];
  },
};

// User docs (src/content/docs/*.mdx) are imported by src/app/docs, never used
// as route files — so no `pageExtensions` on purpose. Plugins are named as
// strings because Turbopack cannot receive plugin functions.
const withMDX = createMDX({
  options: { remarkPlugins: ["remark-gfm"] },
});

export default withMDX(nextConfig);
