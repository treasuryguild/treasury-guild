import "server-only";

import { App, type Octokit } from "octokit";
import {
  githubAppId,
  githubAppPrivateKey,
  githubAppSlug,
} from "@/lib/env.server";
import { UpstreamError } from "@/lib/errors";

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

/**
 * Uninstall the App from the account an installation belongs to (as the App
 * itself). A 404 means GitHub already removed it, which is the desired end
 * state; anything else is an upstream failure the caller should surface
 * without changing local state.
 */
export async function deleteGithubInstallation(installationId: number): Promise<void> {
  try {
    await githubApp().octokit.rest.apps.deleteInstallation({ installation_id: installationId });
  } catch (err) {
    if ((err as { status?: number }).status === 404) return;
    console.error(`deleting github installation ${installationId} failed`, err);
    throw new UpstreamError("GitHub installation could not be removed");
  }
}
