// "Updates" card in Settings → Connections, shown to admins only.
//
// The server compares what it's running against GitHub. Two identities are in
// play, because one of them is often missing: the commit an image was built
// from (exact, but empty unless COMMIT_HASH was passed at build time — a plain
// `docker compose up --build` doesn't) and the release version from
// package.json, which is always there. The card leads with whichever it has.
//
// Whether the update can be *applied* from here depends on the deployment. The
// shipped container has no git checkout and no Docker socket — deliberately,
// since mounting the socket grants it root-equivalent control of the host — so
// by default this reports what's available and hands over the one command to
// run. Operators who opt in (SELF_UPDATE=1 plus the mounts) get a button.

import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { client } from "~/auth/session";
import { canSelfUpdate, hasBackend } from "~/lib/serverConfig";
import { settings, updateSettings } from "~/settings/store";
import { log } from "~/lib/log";
import { Icon } from "~/ui/Icon";

interface UpdateStatus {
  current: string;
  latest: string;
  currentVersion: string;
  latestVersion: string;
  behind: number | null;
  updateAvailable: boolean;
  publishedAt?: string;
  message?: string;
  compareUrl?: string;
  repo: string;
  branch: string;
  canSelfUpdate: boolean;
  error?: string;
}

const UPDATE_COMMAND = "bun run update";

// Re-check this often while the tab is open, so a long-running instance notices
// a release without anyone pressing anything.
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

// After the updater restarts the server, poll until it answers again.
const RESTART_POLL_MS = 2_000;
const RESTART_TIMEOUT_MS = 5 * 60_000;

// Phases the card walks through, so "is it doing anything?" is always answered.
type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "applying" }
  | { kind: "restarting"; since: number }
  | { kind: "done"; version: string }
  | { kind: "error"; message: string };

function short(sha: string): string {
  return sha ? sha.slice(0, 8) : "";
}

// What to call the running build: the release version if known, else the commit.
function identity(s: UpdateStatus): string {
  if (s.currentVersion) return `v${s.currentVersion}`;
  if (s.current) return short(s.current);
  return "unknown";
}

function latestIdentity(s: UpdateStatus): string {
  if (s.latestVersion) return `v${s.latestVersion}`;
  return short(s.latest) || "unknown";
}

export function UpdateCheck() {
  const [status, setStatus] = createSignal<UpdateStatus | null>(null);
  const [phase, setPhase] = createSignal<Phase>({ kind: "idle" });
  const [log_, setLog] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  // Guard so auto-install fires at most once per page load, however many times
  // the check runs.
  let autoInstallTried = false;

  const busy = () => {
    const p = phase().kind;
    return p === "checking" || p === "applying" || p === "restarting";
  };

  async function check(force = false): Promise<UpdateStatus | null> {
    setPhase({ kind: "checking" });
    try {
      const res = await fetch(`/api/update/check${force ? "?force=1" : ""}`);
      if (!res.ok) throw new Error(`Update check failed (HTTP ${res.status})`);
      const data = (await res.json()) as UpdateStatus;
      setStatus(data);
      setPhase({ kind: "idle" });
      return data;
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : "Update check failed",
      });
      return null;
    }
  }

  // Wait for the server to come back after it restarts itself, then report what
  // it came back as. The request being cut off mid-flight is the expected path,
  // not a failure, so this polls rather than trusting the response.
  async function awaitRestart(before: UpdateStatus | null): Promise<void> {
    const started = Date.now();
    setPhase({ kind: "restarting", since: started });
    while (Date.now() - started < RESTART_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
      try {
        const res = await fetch(`/api/update/check?force=1`, { cache: "no-store" });
        if (!res.ok) continue;
        const data = (await res.json()) as UpdateStatus;
        const changed =
          (!!data.current && data.current !== before?.current) ||
          (!!data.currentVersion && data.currentVersion !== before?.currentVersion);
        if (changed || !data.updateAvailable) {
          setStatus(data);
          setPhase({ kind: "done", version: identity(data) });
          return;
        }
      } catch {
        // Still down — that's what we're waiting for.
      }
    }
    setPhase({
      kind: "error",
      message: "The server hasn't come back yet. Check the container logs, then reload this page.",
    });
  }

  async function apply(opts: { confirmFirst?: boolean } = {}): Promise<void> {
    if (opts.confirmFirst !== false) {
      const ok = confirm(
        "Update now? This rebuilds and restarts the app — playback will stop and the page " +
          "will need reloading once it's back.",
      );
      if (!ok) return;
    }
    const before = status();
    setPhase({ kind: "applying" });
    setLog(null);
    try {
      const res = await fetch("/api/update/apply", {
        method: "POST",
        headers: client()?.getServerAuthHeaders() ?? {},
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; log?: string; error?: string }
        | null;
      if (!res.ok) throw new Error(data?.error ?? `Update failed (HTTP ${res.status})`);
      setLog(data?.log ?? null);
      await awaitRestart(before);
    } catch (err) {
      // A TypeError means the connection dropped — which is exactly what happens
      // when the updater restarts the container out from under the request.
      if (err instanceof TypeError) {
        await awaitRestart(before);
        return;
      }
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : "Update failed",
      });
    }
  }

  // Automatic checking, and optionally installing.
  createEffect(
    on(
      () => settings.updates.autoCheck && hasBackend(),
      (enabled) => {
        if (!enabled) return;
        void runAutoCheck();
        const timer = setInterval(() => void runAutoCheck(), AUTO_CHECK_INTERVAL_MS);
        onCleanup(() => clearInterval(timer));
      },
    ),
  );

  async function runAutoCheck(): Promise<void> {
    if (busy()) return;
    const data = await check();
    if (!data?.updateAvailable) return;
    log.info("updates", `update available: ${latestIdentity(data)}`);
    if (!settings.updates.autoInstall || !data.canSelfUpdate || autoInstallTried) return;
    autoInstallTried = true;
    log.info("updates", "installing automatically");
    // No confirm dialog: the operator already opted in by turning this on, and
    // a modal nobody is present to answer would just block the update.
    await apply({ confirmFirst: false });
  }

  async function copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(UPDATE_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setPhase({
        kind: "error",
        message: "Couldn't copy to the clipboard — select the command and copy it manually.",
      });
    }
  }

  return (
    <div class="settings-block">
      <h3 class="settings-block-title">Updates</h3>

      <Show
        when={hasBackend()}
        fallback={
          <p class="muted settings-hint">
            This app is served as a static bundle with no backend, so it can't check its own
            version. Update it wherever you deploy it from.
          </p>
        }
      >
        <p class="muted settings-hint">
          Compares the version this server is running against the latest on GitHub.
        </p>

        <div class="update-toggles">
          <label class="update-toggle">
            <input
              type="checkbox"
              checked={settings.updates.autoCheck}
              onChange={(e) => updateSettings((s) => (s.updates.autoCheck = e.currentTarget.checked))}
            />
            <span>Check automatically</span>
          </label>
          <label class="update-toggle" classList={{ "update-toggle-off": !canSelfUpdate() }}>
            <input
              type="checkbox"
              checked={settings.updates.autoInstall}
              disabled={!canSelfUpdate()}
              onChange={(e) =>
                updateSettings((s) => (s.updates.autoInstall = e.currentTarget.checked))
              }
            />
            <span>
              Install automatically
              <Show when={!canSelfUpdate()}>
                <span class="muted"> — needs SELF_UPDATE; a host timer is the safer route</span>
              </Show>
            </span>
          </label>
        </div>

        <div class="update-actions">
          <button class="btn" onClick={() => void check(true)} disabled={busy()}>
            <Show
              when={phase().kind === "checking"}
              fallback={
                <>
                  <Icon name="refresh" size={16} /> Check for updates
                </>
              }
            >
              <span class="spinner" style={{ width: "14px", height: "14px" }} /> Checking…
            </Show>
          </button>

          <Show when={status()?.updateAvailable && canSelfUpdate()}>
            <button class="btn btn-primary" onClick={() => void apply()} disabled={busy()}>
              <Show
                when={phase().kind === "applying" || phase().kind === "restarting"}
                fallback={
                  <>
                    <Icon name="download" size={16} /> Update now
                  </>
                }
              >
                <span class="spinner" style={{ width: "14px", height: "14px" }} />
                {phase().kind === "restarting" ? "Restarting…" : "Updating…"}
              </Show>
            </button>
          </Show>
        </div>

        {/* Live progress. The apply path restarts the server mid-request, so
            without this the card looked frozen for the minute it took. */}
        <Show when={phase().kind === "applying" || phase().kind === "restarting"}>
          <div class="update-progress" role="status">
            <span class="spinner" style={{ width: "15px", height: "15px" }} />
            <span>
              <Show
                when={phase().kind === "restarting"}
                fallback="Rebuilding the image — this takes a few minutes."
              >
                Waiting for the server to come back…
              </Show>
            </span>
          </div>
        </Show>

        <Show when={phase().kind === "done"}>
          {(_) => {
            const p = phase() as { kind: "done"; version: string };
            return (
              <div class="update-note update-current" role="status">
                <Icon name="check" size={15} /> Updated to {p.version}.{" "}
                <button class="update-reload" onClick={() => location.reload()}>
                  Reload to use it
                </button>
              </div>
            );
          }}
        </Show>

        <Show when={status()}>
          {(s) => (
            <div class="update-status">
              <div class="update-row">
                <span class="muted">Running</span>
                <code>{identity(s())}</code>
              </div>
              <div class="update-row">
                <span class="muted">Latest release</span>
                <code>{latestIdentity(s())}</code>
              </div>
              {/* Only worth showing when it adds something the version doesn't. */}
              <Show when={s().current && s().latest && s().current !== s().latest}>
                <div class="update-row">
                  <span class="muted">Latest on {s().branch}</span>
                  <code>{short(s().latest)}</code>
                </div>
              </Show>

              <Show when={s().error}>
                <p class="update-note muted">{s().error}</p>
              </Show>

              <Show when={!s().error && !s().updateAvailable && phase().kind !== "done"}>
                <p class="update-note update-current">
                  <Icon name="check" size={15} /> You're on the latest version.
                </p>
              </Show>

              <Show when={s().updateAvailable}>
                <p class="update-note update-available">
                  <Icon name="trending" size={15} />
                  {s().behind
                    ? ` ${s().behind} update${s().behind === 1 ? "" : "s"} available`
                    : ` ${latestIdentity(s())} is available`}
                  {s().message ? ` — latest: ${s().message}` : ""}
                </p>
                <Show when={s().compareUrl}>
                  <a
                    class="update-link"
                    href={s().compareUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    See what changed <Icon name="chevron-right" size={13} />
                  </a>
                </Show>

                <Show when={!canSelfUpdate()}>
                  <p class="update-note muted">
                    To install it, run this in the folder you deployed from:
                  </p>
                  <div class="update-command">
                    <code>{UPDATE_COMMAND}</code>
                    <button class="btn" onClick={() => void copyCommand()}>
                      <Icon name={copied() ? "check" : "copy"} size={15} />
                      {copied() ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p class="update-note muted">
                    To have it happen on its own, run that command from a nightly timer on the
                    host — it's non-interactive and does nothing when you're already current.
                    See <em>Scheduled updates</em> in DEPLOYMENT.md. That keeps the app itself
                    unprivileged, unlike <code>SELF_UPDATE</code>, which can install from this
                    page but only by giving the container control of the Docker host.
                  </p>
                </Show>
              </Show>
            </div>
          )}
        </Show>

        <Show when={phase().kind === "error"}>
          {(_) => {
            const p = phase() as { kind: "error"; message: string };
            return (
              <p class="update-note update-error" role="alert">
                {p.message}
              </p>
            );
          }}
        </Show>

        <Show when={log_()}>
          <pre class="update-log">{log_()}</pre>
        </Show>
      </Show>
    </div>
  );
}
