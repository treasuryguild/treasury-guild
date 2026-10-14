import "server-only";

import type * as MeshCsl from "@meshsdk/core-csl";

// Use Mesh's CommonJS entry on the server. Its ESM entry imports a named
// export from whisky-evaluator, whose ESM .js files lack a package type.
// Runtimes with module detection disabled (including Netlify) reject that
// import before a route can run. require also selects the Node WASM loader.
// Keep a literal require so Next.js traces the package and its WASM files.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const meshCsl = require("@meshsdk/core-csl") as typeof MeshCsl;

export const csl = meshCsl.csl;
