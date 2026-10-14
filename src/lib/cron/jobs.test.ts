// Keeps the three places a scheduled job lives in step: the registry here,
// its /api/cron/<id> route and the Netlify scheduled function that calls it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CRON_JOB_IDS, CRON_JOBS } from "./jobs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const routeFile = (id: string) => `${ROOT}src/app/api/cron/${id}/route.ts`;
const functionFile = (id: string) => `${ROOT}netlify/functions/cron-${id}.mts`;

describe("CRON_JOBS", () => {
  it("has exactly one entry per id, in id order", () => {
    expect(CRON_JOBS.map((job) => job.id)).toEqual([...CRON_JOB_IDS]);
    expect(new Set(CRON_JOB_IDS).size).toBe(CRON_JOB_IDS.length);
  });

  it("gives every job a title, a cadence and a description", () => {
    for (const job of CRON_JOBS) {
      expect(job.title.trim(), job.id).not.toBe("");
      expect(job.schedule.trim(), job.id).not.toBe("");
      expect(job.description.trim(), job.id).not.toBe("");
    }
    expect(new Set(CRON_JOBS.map((job) => job.title)).size).toBe(CRON_JOBS.length);
  });

  it("uses ids that are safe path segments", () => {
    for (const id of CRON_JOB_IDS) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});

describe.each([...CRON_JOB_IDS])("cron job %s", (id) => {
  it("has its /api/cron route, a cronRoute POST", () => {
    expect(existsSync(routeFile(id)), routeFile(id)).toBe(true);
    const source = readFileSync(routeFile(id), "utf8");
    expect(source).toContain("cronRoute");
    expect(source).toMatch(/export const POST\b/);
  });

  it("has its Netlify scheduled function, which calls that route", () => {
    expect(existsSync(functionFile(id)), functionFile(id)).toBe(true);
    const source = readFileSync(functionFile(id), "utf8");
    expect(source).toContain(`"/api/cron/${id}"`);
    expect(source).toMatch(/schedule:\s*"/);
  });
});

describe("cron files on disk", () => {
  it("has no /api/cron route outside the registry", () => {
    const dirs = readdirSync(`${ROOT}src/app/api/cron`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(dirs.sort()).toEqual([...CRON_JOB_IDS].sort());
  });

  it("has no Netlify cron function outside the registry", () => {
    const functions = readdirSync(`${ROOT}netlify/functions`)
      .filter((name) => name.startsWith("cron-") && name.endsWith(".mts"))
      .map((name) => name.slice("cron-".length, -".mts".length));
    expect(functions.sort()).toEqual([...CRON_JOB_IDS].sort());
  });
});
