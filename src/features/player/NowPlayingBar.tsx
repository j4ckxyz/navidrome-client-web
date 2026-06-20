// The persistent now-playing bar. Always visible once something is queued, with
// full transport controls, a seek bar, and volume. Given it never leaves the
// screen, it gets extra attention: live progress, current-track art, star.

import { A } from "@solidjs/router";
import { createMemo, createSignal, Show } from "solid-js";
import { player } from "~/player/store";
import { settings, updateSettings } from "~/settings/store";
import { openFullScreen } from "./fullscreen";
import { isStarred, toggleStar } from "~/features/stars";
import { CoverArt } from "~/ui/CoverArt";
import { Icon } from "~/ui/Icon";
import { Slider } from "~/ui/Slider";
import { MenuButton, type ActionItem } from "~/ui/Menu";
import { formatDuration } from "~/lib/format";
import "./nowplaying.css";

export function NowPlayingBar() {
  const song = createMemo(() => player.current());
  const volIcon = createMemo(() => {
    if (player.state.muted || player.state.volume === 0) return "volume-mute";
    if (player.state.volume < 0.5) return "volume-low";
    return "volume";
  });

  const [pop, setPop] = createSignal(false);
  function starCurrent() {
    const s = song();
    if (!s) return;
    const becoming = !isStarred(s.id, s.starred);
    toggleStar(s.id, s.starred, "song");
    if (becoming) {
      setPop(true);
      window.setTimeout(() => setPop(false), 360);
    }
  }

  const sleepItems = (): ActionItem[] => {
    const m = player.sleepMode();
    const mk = (label: string, mode: number | "end"): ActionItem => ({
      label: m === mode ? `${label}  ✓` : label,
      onSelect: () => player.setSleepTimer(mode),
    });
    const items: ActionItem[] = [
      mk("15 minutes", 15),
      mk("30 minutes", 30),
      mk("45 minutes", 45),
      mk("1 hour", 60),
      mk("End of track", "end"),
    ];
    if (m !== null) {
      items.push({
        label: "Turn off",
        icon: "close",
        danger: true,
        separatorBefore: true,
        onSelect: () => player.setSleepTimer(null),
      });
    }
    return items;
  };

  return (
    <footer class="np-bar" classList={{ "np-empty": !song() }}>
      <div class="np-left">
        <Show when={song()} fallback={<div class="np-placeholder muted">Nothing playing</div>}>
          <button
            class="np-cover-btn"
            onClick={openFullScreen}
            aria-label="Open full screen player"
            title="Open full screen"
          >
            <CoverArt coverArt={song()!.coverArt} size={56} alt="" />
            <span class="np-cover-expand">
              <Icon name="chevron-right" size={18} />
            </span>
          </button>
          {/* Re-key on the track id so title/artist crossfade in step with the
              album art when the song changes. */}
          <Show when={song()!.id} keyed>
            <div class="np-meta">
              <A href={song()!.albumId ? `/album/${song()!.albumId}` : "#"} class="np-title">
                {song()!.title}
              </A>
              <A
                href={song()!.artistId ? `/artist/${song()!.artistId}` : "#"}
                class="np-artist muted"
              >
                {song()!.artist}
              </A>
            </div>
          </Show>
          <button
            class="icon-btn np-star"
            classList={{ active: isStarred(song()!.id, song()!.starred), "heart-pop": pop() }}
            onClick={() => starCurrent()}
            aria-label="Favourite"
          >
            <Icon name={isStarred(song()!.id, song()!.starred) ? "heart-filled" : "heart"} size={18} />
          </button>
        </Show>
      </div>

      <div class="np-center">
        <div class="np-controls">
          <button
            class="icon-btn"
            classList={{ active: player.state.shuffle }}
            onClick={() => player.toggleShuffle()}
            aria-label="Shuffle"
            aria-pressed={player.state.shuffle}
          >
            <Icon name="shuffle" size={17} />
          </button>
          <button class="icon-btn" onClick={() => player.previous()} aria-label="Previous">
            <Icon name="prev" size={20} />
          </button>
          <button class="np-play" onClick={() => player.togglePlay()} aria-label={player.state.isPlaying ? "Pause" : "Play"}>
            <Icon name={player.state.isPlaying ? "pause" : "play"} size={22} />
          </button>
          <button class="icon-btn" onClick={() => player.next()} aria-label="Next">
            <Icon name="next" size={20} />
          </button>
          <button
            class="icon-btn"
            classList={{ active: player.state.repeat !== "off" }}
            onClick={() => player.cycleRepeat()}
            aria-label={`Repeat: ${player.state.repeat}`}
          >
            <Icon name={player.state.repeat === "one" ? "repeat-one" : "repeat"} size={17} />
          </button>
        </div>

        <div class="np-seek">
          <span class="np-time muted">{formatDuration(player.state.currentTime)}</span>
          <Slider
            value={player.state.currentTime}
            max={player.state.duration || 1}
            onInput={(v) => player.seek(v)}
            ariaLabel="Seek"
          />
          <span class="np-time muted">{formatDuration(player.state.duration)}</span>
        </div>
      </div>

      <div class="np-right">
        <button
          class="icon-btn"
          classList={{ active: settings.layout.showLyricsPanel }}
          onClick={() => updateSettings((s) => (s.layout.showLyricsPanel = !s.layout.showLyricsPanel))}
          aria-label="Toggle lyrics"
        >
          <Icon name="lyrics" size={18} />
        </button>
        <button
          class="icon-btn"
          classList={{ active: settings.layout.showQueuePanel }}
          onClick={() => updateSettings((s) => (s.layout.showQueuePanel = !s.layout.showQueuePanel))}
          aria-label="Toggle queue"
        >
          <Icon name="queue" size={18} />
        </button>
        <MenuButton
          items={sleepItems()}
          icon="clock"
          iconSize={18}
          label="Sleep timer"
          class={player.sleepMode() !== null ? "active" : ""}
        />
        <div class="np-volume">
          <button class="icon-btn" onClick={() => player.toggleMute()} aria-label="Mute">
            <Icon name={volIcon()} size={18} />
          </button>
          <Slider
            value={player.state.muted ? 0 : player.state.volume * 100}
            max={100}
            onInput={(v) => player.setVolume(v / 100)}
            ariaLabel="Volume"
            class="np-volume-slider"
          />
        </div>
      </div>
    </footer>
  );
}
