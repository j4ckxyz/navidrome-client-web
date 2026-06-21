// Bottom tab bar shown on small screens. Gives thumb-reachable access to the
// core destinations; the "More" tab opens the full sidebar as a drawer for
// playlists, genres, settings, and the rest. Hidden on desktop via CSS.

import { A } from "@solidjs/router";
import { For } from "solid-js";
import { Icon, type IconName } from "~/ui/Icon";
import { openDrawer, closeDrawer } from "./drawer";
import "./mobilenav.css";

const TABS: { href: string; label: string; icon: IconName; end?: boolean }[] = [
  { href: "/", label: "Home", icon: "home", end: true },
  { href: "/albums", label: "Albums", icon: "disc" },
  { href: "/artists", label: "Artists", icon: "mic" },
  { href: "/favourites", label: "Favourites", icon: "heart" },
];

export function MobileNav() {
  return (
    <nav class="mobile-nav" aria-label="Primary">
      <For each={TABS}>
        {(tab) => (
          <A
            href={tab.href}
            end={tab.end}
            class="mobile-nav-item"
            activeClass="mobile-nav-item-active"
            onClick={closeDrawer}
          >
            <Icon name={tab.icon} size={22} />
            <span>{tab.label}</span>
          </A>
        )}
      </For>
      <button class="mobile-nav-item" onClick={openDrawer} aria-label="More">
        <Icon name="menu" size={22} />
        <span>More</span>
      </button>
    </nav>
  );
}
