// Recovery UI for a crashed render.
//
// Solid propagates a render error to the nearest boundary, and without one it
// reaches the root and unmounts everything — sidebar, player and all. Two
// boundaries use this: one inside the shell, so a failing page leaves the music
// playing, and one at the root as a last resort.

import { Show } from "solid-js";
import { Icon } from "./Icon";
import "./errorstate.css";

function messageFor(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function ErrorState(props: {
  error: unknown;
  reset?: () => void;
  // Whole-app failures can't offer "keep listening" — the player is gone too.
  fatal?: boolean;
}) {
  return (
    <div class="error-state" role="alert">
      <div class="error-state-inner">
        <Icon name="close" size={26} />
        <h2>{props.fatal ? "Tonearm hit a problem" : "This page didn't load"}</h2>
        <p class="muted">
          {props.fatal
            ? "Something broke badly enough to take the app down. Reloading usually clears it."
            : "The rest of the app is still running, and playback hasn't stopped. Try again, or go somewhere else."}
        </p>
        <pre class="error-state-detail">{messageFor(props.error)}</pre>
        <div class="error-state-actions">
          <Show when={props.reset}>
            <button class="btn btn-primary" onClick={() => props.reset!()}>
              Try again
            </button>
          </Show>
          <Show when={!props.fatal}>
            <a class="btn" href="/">
              Go home
            </a>
          </Show>
          <button class="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
