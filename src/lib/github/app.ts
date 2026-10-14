import "server-only";

import { App, type Octokit } from "octokit";
import {
  githubAppId,
  githubAppPrivateKey,
  githubAppSlug,
} from "@/lib/env.server";

let app: App | undefined;

export function githubApp(): App {
  if (!app) {
    app = new App({ appId: githubAppId(), privateKey: githubAppPrivateKey() });
  }
  return app;
}

export async function installationOctokit(
  installationId: number,
): Promise<Octokit> {
  return githubApp().getInstallationOctokit(installationId);
}

export function installUrl(state: string): string {
  return `https://github.com/apps/${githubAppSlug()}/installations/new?state=${encodeURIComponent(state)}`;
}
