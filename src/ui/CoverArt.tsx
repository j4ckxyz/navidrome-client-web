// Cover art with graceful fallback. Album art is the primary visual element in
// this app, so the placeholder is deliberately calm rather than a broken image.

import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { client } from "~/auth/session";
import { Icon } from "./Icon";
import "./coverart.css";

export function CoverArt(props: {
  coverArt?: string;
  size?: number;
  rounded?: boolean;
  alt?: string;
  class?: string;
}) {
  const url = createMemo(() => {
    const c = client();
    if (!c || !props.coverArt) return "";
    return c.coverArtUrl(props.coverArt, props.size ? props.size * 2 : 600);
  });

  const [loaded, setLoaded] = createSignal(false);

  createEffect(() => {
    url();
    setLoaded(false);
  });

  return (
    <div
      class={`cover ${props.rounded ? "cover-round" : ""} ${props.class ?? ""}`}
      style={props.size ? { width: `${props.size}px`, height: `${props.size}px` } : undefined}
    >
      <Show
        when={url()}
        fallback={
          <div class="cover-fallback">
            <Icon name="disc" size={props.size ? Math.max(18, props.size / 3) : 28} />
          </div>
        }
      >
        <img
          src={url()}
          alt={props.alt ?? ""}
          loading="lazy"
          draggable={false}
          onLoad={() => setLoaded(true)}
          class="cover-img"
          classList={{ "cover-loaded": loaded() }}
        />
      </Show>
    </div>
  );
}
