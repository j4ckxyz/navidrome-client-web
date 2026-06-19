#!/usr/bin/env bun
/**
 * Cross-platform updater for navidrome-client-web.
 *
 * Run with `bun run update`. Works on Windows, macOS, and Linux, and with both
 * Docker Compose v2 (`docker compose`) and v1 (`docker-compose`).
 *
 * What it does:
 *   1. Checks GitHub (the `origin` remote) for a newer version.
 *   2. If there is one, updates the working tree to it WITHOUT touching your
 *      local Docker Compose / .env files, so your deployment config is never
 *      clobbered.
 *   3. Rebuilds and restarts the Docker stack (full or client-only, whichever
 *      is running) so you end up on the latest version.
 *
 * It is safe to run repeatedly: if you're already on the latest commit and the
 * running container matches it, it exits without rebuilding.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// Config files that belong to the user's deployment, not the repo's source.
// These are preserved verbatim across the update so a pull can't break config.
const CONFIG_FILES = [
  "docker-compose.yml",
  "docker-compose.full.yml",
  "docker-compose.override.yml",
  ".env",
];

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
    // shell:false is the default; passing argv arrays avoids quoting issues and
    // is identical across platforms.
  });
  if (res.error && !opts.allowFail) {
    fail(`Failed to run "${cmd} ${args.join(" ")}": ${res.error.message}`);
  }
  return res;
}

// Capture trimmed stdout of a command, or "" if it fails.
function capture(cmd: string, args: string[]): string {
  const res = run(cmd, args, { capture: true, allowFail: true });
  if (res.status !== 0 || res.error) return "";
  return (res.stdout ?? "").trim();
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function ok(cmd: string, args: string[]): boolean {
  const res = run(cmd, args, { capture: true, allowFail: true });
  return !res.error && res.status === 0;
}

// --- Pre-flight ------------------------------------------------------------

console.log("Updating navidrome-client-web…\n");

if (!ok("git", ["rev-parse", "--is-inside-work-tree"])) {
  fail("This is not a git checkout, so there's nothing to update from GitHub.");
}

// Resolve the Docker Compose command for both v2 (plugin) and v1 (standalone).
function resolveCompose(): string[] | null {
  if (ok("docker", ["compose", "version"])) return ["docker", "compose"];
  if (ok("docker-compose", ["version"])) return ["docker-compose"];
  return null;
}
const compose = resolveCompose();
if (!compose) {
  fail("Docker Compose was not found. Install Docker Desktop or the compose plugin and retry.");
}

// --- Check GitHub for updates ---------------------------------------------

const branch = capture("git", ["symbolic-ref", "--short", "-q", "HEAD"]) || "main";

console.log(`Fetching latest changes from GitHub (origin/${branch})…`);
if (!ok("git", ["fetch", "origin", "--tags", "--prune"])) {
  fail("Could not reach GitHub. Check your network and that 'origin' points at the repo.");
}

const local = capture("git", ["rev-parse", "HEAD"]);
const remote =
  capture("git", ["rev-parse", `origin/${branch}`]) || capture("git", ["rev-parse", "origin/main"]);

if (!remote) {
  fail(`Could not resolve origin/${branch}. Is the remote configured?`);
}

const updatesAvailable = local !== remote;

// What commit is the running image built from?
const builtCommit = capture("docker", [
  "inspect",
  "-f",
  '{{index .Config.Labels "org.opencontainers.image.revision"}}',
  "navidrome-client-web:latest",
]);

// Is the client container up?
const clientRunning =
  capture("docker", ["ps", "-q", "-f", "name=^navidrome-web$"]).length > 0;

if (!updatesAvailable && builtCommit === local && clientRunning) {
  console.log(`\n✓ Already up to date — container is running the latest version (${short(local)}).`);
  process.exit(0);
}

// --- Apply the update, preserving local config -----------------------------

if (updatesAvailable) {
  console.log(`New version found: ${short(local)} → ${short(remote)}`);
  console.log("Updating source (your Docker Compose and .env files are preserved)…");

  // 1. Back up the user's config files to a temp dir.
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
    // 2. Stash any local changes so the update is clean (config is restored from
    //    backup afterwards, so its stash copy is irrelevant).
    const dirty = capture("git", ["status", "--porcelain"]).length > 0;
    if (dirty) {
      run("git", ["stash", "push", "--include-untracked", "-m", "ndweb-update-autostash"], {
        capture: true,
        allowFail: true,
      });
    }

    // 3. Move to the latest upstream commit. Prefer a fast-forward; fall back to
    //    a hard reset so the update always succeeds and lands exactly on origin.
    if (!ok("git", ["merge", "--ff-only", `origin/${branch}`])) {
      console.log("Fast-forward not possible; resetting to the latest upstream commit…");
      if (!ok("git", ["reset", "--hard", `origin/${branch}`])) {
        fail("Could not update to the latest commit. Resolve git state manually and retry.");
      }
    }

    // 4. Drop the autostash (don't pop — it would re-introduce old code/config).
    if (dirty) {
      run("git", ["stash", "drop"], { capture: true, allowFail: true });
    }
  } finally {
    // 5. Restore the user's config files over whatever the update brought in.
    for (const { file, backup } of backedUp) {
      copyFileSync(backup, file);
    }
    rmSync(backupDir, { recursive: true, force: true });
  }

  console.log("Source updated. Local config restored.");
} else {
  console.log("Source already current; rebuilding to sync the running container…");
}

// --- Rebuild & restart the Docker stack ------------------------------------

const head = capture("git", ["rev-parse", "HEAD"]);

const composeFile = detectComposeFile();
const fullStack = composeFile === "docker-compose.full.yml";
console.log(
  `\n${fullStack ? "Full stack" : "Client-only"} deployment detected.` +
    ` Rebuilding with ${composeFile}…`,
);

const buildEnv = { ...process.env, COMMIT_HASH: head };
const composeBase = compose.slice(1); // [] for v1, ["compose"] for v2

// Tear the existing stack down before rebuilding. Recreating in place can fail
// with a "container name already in use" conflict when the running container was
// created under a different Compose project (different path/casing/tool). So:
//   1. `down` the current project cleanly,
//   2. force-remove any leftover containers by name (down only touches the
//      current project; this catches cross-project leftovers),
//   3. build and start fresh.
// Removing the containers is safe — all persistent data lives in bind mounts /
// named volumes (./nd-data, ./music), not in the containers themselves.
console.log("Stopping the current stack…");
run(compose[0], [...composeBase, "-f", composeFile, "down", "--remove-orphans"], {
  env: buildEnv,
  allowFail: true,
});

// Force-remove only containers we positively own (down only touches the current
// project, so this catches cross-project leftovers). `navidrome-web` is always
// ours. `navidrome` is ONLY ever removed in full-stack mode AND only when it
// belongs to our full-stack compose project — never an externally-managed
// Navidrome that merely shares the name.
const stale: string[] = ["navidrome-web"];
if (fullStack && ownedByUs("navidrome", composeFile)) stale.push("navidrome");
else if (fullStack && containerExists("navidrome")) {
  console.log(
    'Note: a "navidrome" container exists but isn\'t part of this stack — leaving it untouched.',
  );
}
for (const name of stale) {
  run("docker", ["rm", "-f", name], { capture: true, allowFail: true });
}

console.log("Building and starting the latest version…");
const buildRes = run(compose[0], [...composeBase, "-f", composeFile, "up", "-d", "--build"], {
  env: buildEnv,
});
if (buildRes.status !== 0) {
  fail("Docker build/restart failed. See the output above for details.");
}

console.log(`\n✓ Update complete — now running ${short(head)}.`);

function short(hash: string): string {
  return hash ? hash.slice(0, 8) : "unknown";
}

// Decide which compose file drives this deployment, from the Compose config-files
// label on the web container. We deliberately DEFAULT TO CLIENT-ONLY: full stack
// is chosen only when positively confirmed, so a client-only deployment that
// proxies to an externally-managed Navidrome is never mistaken for the bundled
// stack (which would otherwise try to manage/replace that external container).
function detectComposeFile(): string {
  const label = composeConfigLabel("navidrome-web");
  return label.includes("docker-compose.full.yml") ? "docker-compose.full.yml" : "docker-compose.yml";
}

// The Compose "config files" label records which compose file created a
// container ("" if it isn't Compose-managed).
function composeConfigLabel(name: string): string {
  return capture("docker", [
    "inspect",
    name,
    "--format",
    '{{index .Config.Labels "com.docker.compose.project.config_files"}}',
  ]);
}

function containerExists(name: string): boolean {
  return capture("docker", ["ps", "-aq", "-f", `name=^${name}$`]).length > 0;
}

// True only when the named container was created by OUR compose file — the guard
// that stops the updater from ever force-removing an external Navidrome.
function ownedByUs(name: string, composeFile: string): boolean {
  if (!containerExists(name)) return false;
  return composeConfigLabel(name).includes(composeFile);
}
