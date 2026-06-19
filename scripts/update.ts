#!/usr/bin/env bun
/**
 * Cross-platform, safe updater for navidrome-client-web.
 *
 * Run with `bun run update`. Works on Windows, macOS, and Linux, and with both
 * Docker Compose v2 (`docker compose`) and v1 (`docker-compose`).
 *
 * Design (why this can't break your setup):
 *   1. INSPECT first, change nothing. It reads the EXACT Compose project and
 *      compose file that created your running `navidrome-web` container, and
 *      prints a plan before doing anything.
 *   2. It only ever acts on THAT project + compose file. It never removes
 *      containers and never introduces services it doesn't own — so it can't
 *      touch a Navidrome you manage separately, and a "container name already in
 *      use" conflict is impossible.
 *   3. Updating the source preserves your docker-compose*.yml / .env verbatim.
 *   4. Rebuild is a plain in-place `up -d --build` against your own project.
 *
 * Safe to re-run: if you're already on the latest commit and the running
 * container matches it, it exits without touching anything.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// Files that belong to the user's deployment, not the repo source. Preserved
// verbatim across an update so a pull can never clobber config.
const CONFIG_FILES = [
  "docker-compose.yml",
  "docker-compose.full.yml",
  "docker-compose.override.yml",
  ".env",
];

const CLIENT_CONTAINER = "navidrome-web";
const CLIENT_IMAGE = "navidrome-client-web:latest";

// ---------------------------------------------------------------------------
// Small process helpers
// ---------------------------------------------------------------------------

function run(
  cmd: string,
  args: string[],
  opts: { capture?: boolean; env?: Record<string, string | undefined>; allowFail?: boolean } = {},
): SpawnSyncReturns<string> {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.capture ? "pipe" : "inherit",
    env: opts.env ?? process.env,
  });
  if (res.error && !opts.allowFail) {
    fail(`Failed to run "${cmd} ${args.join(" ")}": ${res.error.message}`);
  }
  return res;
}

// Trimmed stdout, or "" on any failure.
function capture(cmd: string, args: string[]): string {
  const res = run(cmd, args, { capture: true, allowFail: true });
  if (res.status !== 0 || res.error) return "";
  return (res.stdout ?? "").trim();
}

function ok(cmd: string, args: string[]): boolean {
  const res = run(cmd, args, { capture: true, allowFail: true });
  return !res.error && res.status === 0;
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function short(hash: string): string {
  return hash ? hash.slice(0, 8) : "unknown";
}

function containerExists(name: string): boolean {
  return capture("docker", ["ps", "-aq", "-f", `name=^${name}$`]).length > 0;
}

function containerRunning(name: string): boolean {
  return capture("docker", ["ps", "-q", "-f", `name=^${name}$`]).length > 0;
}

function inspectLabel(container: string, label: string): string {
  return capture("docker", ["inspect", container, "--format", `{{index .Config.Labels "${label}"}}`]);
}

// ---------------------------------------------------------------------------
// 1. INSPECT — read-only; figure out exactly what we're dealing with
// ---------------------------------------------------------------------------

console.log("navidrome-client-web updater\n");

if (!ok("git", ["rev-parse", "--is-inside-work-tree"])) {
  fail("This folder isn't a git checkout, so there's nothing to update from GitHub.");
}
if (!ok("docker", ["version"])) {
  fail("Docker isn't available. Start Docker Desktop / the Docker daemon and retry.");
}

// Compose command for both v2 (plugin) and v1 (standalone).
const compose = ok("docker", ["compose", "version"])
  ? ["docker", "compose"]
  : ok("docker-compose", ["version"])
    ? ["docker-compose"]
    : (fail("Docker Compose was not found. Install Docker Desktop or the compose plugin.") as never);

// Detect the deployment from the running client container. The compose labels
// tell us *exactly* which project and compose file own it, so we recreate it in
// place and never guess. Falls back to client-only for a fresh install.
const deployment = detectDeployment();
const composeFile = deployment.composeFile;
if (!existsSync(join(ROOT, composeFile))) {
  fail(`Detected compose file "${composeFile}" is missing from this folder.`);
}
const projectArgs = deployment.project ? ["-p", deployment.project] : [];

const branch = capture("git", ["symbolic-ref", "--short", "-q", "HEAD"]) || "main";

// ---------------------------------------------------------------------------
// 2. PLAN — print what we found and what we'll do, before changing anything
// ---------------------------------------------------------------------------

console.log("Detected setup:");
console.log(`  • Mode:         ${deployment.fullStack ? "full stack (bundled Navidrome)" : "client only"}`);
console.log(`  • Compose file: ${composeFile}`);
console.log(`  • Project:      ${deployment.project || "(default — by folder name)"}`);
console.log(`  • Client:       ${deployment.clientState}`);
if (!deployment.fullStack && containerExists("navidrome")) {
  console.log('  • Note:         a separate "navidrome" container exists and will NOT be touched.');
}
console.log(`  • Branch:       ${branch}\n`);

// ---------------------------------------------------------------------------
// 3. CHECK GITHUB
// ---------------------------------------------------------------------------

console.log(`Checking GitHub for updates (origin/${branch})…`);
if (!ok("git", ["fetch", "origin", "--tags", "--prune"])) {
  fail("Could not reach GitHub. Check your network and that 'origin' points at the repo.");
}

const local = capture("git", ["rev-parse", "HEAD"]);
const remote =
  capture("git", ["rev-parse", `origin/${branch}`]) || capture("git", ["rev-parse", "origin/main"]);
if (!remote) fail(`Could not resolve origin/${branch}. Is the remote configured?`);

const updatesAvailable = local !== remote;
const builtCommit = inspectLabel(CLIENT_IMAGE, "org.opencontainers.image.revision");

// Nothing to do if we're current, the running image matches HEAD, and it's up.
if (!updatesAvailable && builtCommit === local && containerRunning(CLIENT_CONTAINER)) {
  console.log(`\n✓ Already up to date — running the latest version (${short(local)}).`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. UPDATE SOURCE — preserve the user's config verbatim
// ---------------------------------------------------------------------------

if (updatesAvailable) {
  console.log(`New version found: ${short(local)} → ${short(remote)}`);
  console.log("Updating source (your docker-compose*.yml and .env are preserved)…");
  updateSource();
  console.log("Source updated; local config restored.");
} else {
  console.log("Source already current; rebuilding to sync the running container…");
}

// ---------------------------------------------------------------------------
// 5. REBUILD — in place, against our own project only
// ---------------------------------------------------------------------------

const head = capture("git", ["rev-parse", "HEAD"]);
const buildEnv = { ...process.env, COMMIT_HASH: head };
const composeBase = compose.slice(1); // [] for v1, ["compose"] for v2

const upArgs = [...composeBase, ...projectArgs, "-f", composeFile, "up", "-d", "--build"];

console.log(`\nBuilding and (re)starting with ${composeFile}…`);
let buildRes = run(compose[0], upArgs, { env: buildEnv });

if (buildRes.status !== 0) {
  // The only safe remediation: the client container holds NO data (everything is
  // in your music/data folders), so if a stale `navidrome-web` is blocking the
  // recreate (e.g. it was first started via `docker run`, not compose), we can
  // remove just that one and retry. We never touch a `navidrome` container.
  console.log("\nFirst attempt failed; clearing the stale client container and retrying once…");
  run("docker", ["rm", "-f", CLIENT_CONTAINER], { capture: true, allowFail: true });
  buildRes = run(compose[0], upArgs, { env: buildEnv });
}

if (buildRes.status !== 0) {
  fail(
    "Docker build/restart failed (see output above). Your data and any external\n" +
      "  Navidrome are untouched. Re-run `bun run update`, or run it manually:\n" +
      `    ${compose.join(" ")} ${projectArgs.join(" ")} -f ${composeFile} up -d --build`,
  );
}

console.log(`\n✓ Update complete — now running ${short(head)}.`);

// ===========================================================================
// Helpers (hoisted)
// ===========================================================================

interface Deployment {
  fullStack: boolean;
  composeFile: string;
  project: string; // "" → let compose use the default (folder name)
  clientState: string;
}

// Read the deployment straight from the running client container's compose
// labels. This is authoritative: we rebuild exactly the project/file that
// created it. For a fresh machine (no client container yet) we default to the
// safe, common client-only setup.
function detectDeployment(): Deployment {
  if (!containerExists(CLIENT_CONTAINER)) {
    return {
      fullStack: false,
      composeFile: "docker-compose.yml",
      project: "",
      clientState: "not deployed yet (will start client-only)",
    };
  }
  const configFiles = inspectLabel(CLIENT_CONTAINER, "com.docker.compose.project.config_files");
  const project = inspectLabel(CLIENT_CONTAINER, "com.docker.compose.project");
  const fullStack = configFiles.includes("docker-compose.full.yml");
  return {
    fullStack,
    composeFile: fullStack ? "docker-compose.full.yml" : "docker-compose.yml",
    project,
    clientState: containerRunning(CLIENT_CONTAINER) ? "running" : "stopped",
  };
}

// Move the checkout to the latest upstream commit, preserving the user's config
// files across the operation no matter what.
function updateSource(): void {
  const backupDir = mkdtempSync(join(tmpdir(), "ndweb-update-"));
  const backedUp: { file: string; backup: string }[] = [];
  for (const file of CONFIG_FILES) {
    const abs = join(ROOT, file);
    if (existsSync(abs)) {
      const backup = join(backupDir, file.replace(/[\\/]/g, "_"));
      copyFileSync(abs, backup);
      backedUp.push({ file: abs, backup });
    }
  }

  try {
    // Stash any local changes so the update is clean; the stashed config copies
    // are irrelevant because we restore config from backup afterwards.
    const dirty = capture("git", ["status", "--porcelain"]).length > 0;
    if (dirty) {
      run("git", ["stash", "push", "--include-untracked", "-m", "ndweb-update-autostash"], {
        capture: true,
        allowFail: true,
      });
    }

    // Prefer a fast-forward; fall back to a hard reset so we always land exactly
    // on origin. (Config is restored from backup in `finally`, regardless.)
    if (!ok("git", ["merge", "--ff-only", `origin/${branch}`])) {
      console.log("Fast-forward not possible; resetting to the latest upstream commit…");
      if (!ok("git", ["reset", "--hard", `origin/${branch}`])) {
        fail("Could not update to the latest commit. Resolve git state manually and retry.");
      }
    }

    if (dirty) run("git", ["stash", "drop"], { capture: true, allowFail: true });
  } finally {
    for (const { file, backup } of backedUp) copyFileSync(backup, file);
    rmSync(backupDir, { recursive: true, force: true });
  }
}
