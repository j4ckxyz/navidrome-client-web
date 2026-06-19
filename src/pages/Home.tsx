// Home: a set of album carousels drawn straight from the library — recently
// added, most played, recently played, and a random shuffle. No algorithmic
// "discovery"; this is the user's own collection.

import { createQuery } from "@tanstack/solid-query";
import { For, Show } from "solid-js";
import { A } from "@solidjs/router";
import { client, activeUsername } from "~/auth/session";
import { qk } from "~/lib/query";
import type { AlbumListType } from "~/api/client";
import { AlbumCard } from "~/ui/AlbumCard";
import { Icon } from "~/ui/Icon";
import "./home.css";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function Carousel(props: { title: string; type: AlbumListType; href: string }) {
  const q = createQuery(() => ({
    queryKey: qk.albumList(props.type, { size: 14 }),
    queryFn: () => client()!.getAlbumList(props.type, { size: 14 }),
    enabled: !!client(),
  }));

  return (
    <Show when={(q.data?.length ?? 0) > 0}>
      <section class="home-section">
        <div class="home-section-head">
          <h2 class="section-title">{props.title}</h2>
          <A href={props.href} class="home-seeall">
            See all <Icon name="chevron-right" size={14} />
          </A>
        </div>
        <div class="carousel">
          <For each={q.data}>{(album) => <AlbumCard album={album} />}</For>
        </div>
      </section>
    </Show>
  );
}

export default function Home() {
  return (
    <div class="page">
      <h1 class="page-title home-greeting">
        {greeting()}
        <Show when={activeUsername()}>, {activeUsername()}</Show>
      </h1>
      <Carousel title="Recently added" type="newest" href="/albums?sort=newest" />
      <Carousel title="Most played" type="frequent" href="/albums?sort=frequent" />
      <Carousel title="Recently played" type="recent" href="/albums?sort=recent" />
      <Carousel title="Surprise me" type="random" href="/albums?sort=random" />
    </div>
  );
}
