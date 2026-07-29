// "Check for updates" card in Settings → Connections, shown to admins only.
//
// The server knows the commit it was built from (recorded at image build time)
// and compares it against the head of the configured branch on GitHub.
//
// Whether the *update* can then be applied from here depends on the deployment.
// The shipped container has no git checkout and no Docker socket — deliberately,
// since mounting the socket grants it root-equivalent control of the host — so
// by default this reports what's available and hands over the one command to
// run. Operators who opt in (SELF_UPDATE=1 plus the mounts) get a button that
// runs the same updater for them.

import { createSignal, Show } from "solid-js";
import { client } from "~/auth/session";
import { canSelfUpdate, hasBackend } from "~/lib/serverConfig";
import { Icon } from "~/ui/Icon";

interface UpdateStatus {
  current: string;
  latest: string;
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

function short(sha: string): string {
  return sha ? sha.slice(0, 8) : "unknown";
}

export function UpdateCheck() {
  const [status, setStatus] = createSignal<UpdateStatus | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [applying, setApplying] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [log, setLog] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  async function check(force = false) {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch(`/api/update/check${force ? "?force=1" : ""}`);
      if (!res.ok) throw new Error(`Update check failed (HTTP ${res.status})`);
      setStatus((await res.json()) as UpdateStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update check failed");
    } finally {
      setChecking(false);
    }
  }

  async function apply() {
    if (
      !confirm(
        "Update now? This rebuilds and restarts the app — playback will stop and the page " +
          "will need reloading once it's back.",
      )
    ) {
      return;
    }
    setApplying(true);
    setError(null);
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
      await check(true);
    } catch (err) {
      // The updater restarts this container, so the request being cut off part
      // way through is the expected happy path, not a failure.
      setError(
        err instanceof TypeError
          ? "The server restarted while updating — reload the page in a moment to pick up the new version."
          : err instanceof Error
            ? err.message
            : "Update failed",
      );
    } finally {
      setApplying(false);
    }
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(UPDATE_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy to the clipboard — select the command and copy it manually.");
    }
  }

  return (
    <div class="settings-block">
      <h3 class="settings-block-title">Updates</h3>

      <Show
        when={hasBackend()}
        fallback={
          <p class="muted settings-hint">
            This app is served as a static bundle with no {""}
            backend, so it can't check its own version. Update it wherever you deploy it from.
          </p>
        }
      >
        <p class="muted settings-hint">
          Compares the version this server is running against the latest on GitHub.
        </p>

        <div class="update-actions">
          <button class="btn" onClick={() => void check(true)} disabled={checking() || applying()}>
            <Show
              when={checking()}
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
            <button class="btn btn-primary" onClick={() => void apply()} disabled={applying()}>
              <Show
                when={applying()}
                fallback={
                  <>
                    <Icon name="download" size={16} /> Update now
                  </>
                }
              >
                <span class="spinner" style={{ width: "14px", height: "14px" }} /> Updating…
              </Show>
            </button>
          </Show>
        </div>

        <Show when={status()}>
          {(s) => (
            <div class="update-status">
              <div class="update-row">
                <span class="muted">Running</span>
                <code>{short(s().current)}</code>
              </div>
              <Show when={s().latest}>
                <div class="update-row">
                  <span class="muted">Latest on {s().branch}</span>
                  <code>{short(s().latest)}</code>
                </div>
              </Show>

              <Show when={s().error}>
                <p class="update-note muted">{s().error}</p>
              </Show>

              <Show when={!s().error && !s().updateAvailable}>
                <p class="update-note update-current">
                  <Icon name="check" size={15} /> You're on the latest version.
                </p>
              </Show>

              <Show when={s().updateAvailable}>
                <p class="update-note update-available">
                  <Icon name="trending" size={15} />
                  {s().behind
                    ? ` ${s().behind} update${s().behind === 1 ? "" : "s"} available`
                    : " An update is available"}
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
                    The app can also do this for you, but only if you let the container reach
                    Docker — see <code>SELF_UPDATE</code> in DEPLOYMENT.md. That's off by default
                    because it gives the container control of the Docker host.
                  </p>
                </Show>
              </Show>
            </div>
          )}
        </Show>

        <Show when={error()}>
          <p class="update-note update-error" role="alert">
            {error()}
          </p>
        </Show>

        <Show when={log()}>
          <pre class="update-log">{log()}</pre>
        </Show>
      </Show>
    </div>
  );
}
