// Sharing an app deep-link to an album / playlist / artist / song. Uses the
// native share sheet when the browser/OS offers one (mobile, Safari), otherwise
// copies the link to the clipboard and confirms with a small toast.
//
// The link points at this client's own route (e.g. /album/:id). When the backend
// is configured for link previews (see server/index.ts), crawlers that fetch
// that URL get rich OpenGraph/Twitter cards; humans still land on the login-gated
// SPA. See [[project-status]].

import { createSignal, Show } from "solid-js";
import { Icon } from "~/ui/Icon";
import "./share.css";

const [toast, setToast] = createSignal<string | null>(null);
let toastTimer: number | undefined;

function flash(msg: string): void {
  setToast(msg);
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setToast(null), 2600);
}

// Build an absolute URL on the current origin for a client route.
export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

// Share (or copy) a link to a piece of content. `title` is used as the share
// sheet title and a friendlier toast.
export async function shareLink(path: string, title: string): Promise<void> {
  const url = absoluteUrl(path);

  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (err) {
      // AbortError = the user dismissed the sheet; don't fall back to a copy.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Any other failure: fall through to clipboard.
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    flash("Link copied to clipboard");
  } catch {
    // Clipboard blocked (insecure context / permissions): show the URL so the
    // user can copy it manually.
    flash(url);
  }
}

// Mounted once at the app root so the confirmation toast can appear from any page.
export function ShareToast() {
  return (
    <Show when={toast()}>
      <div class="toast" role="status">
        <Icon name="link" size={16} /> {toast()}
      </div>
    </Show>
  );
}
