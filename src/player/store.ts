// Playback store: owns the queue and reactive playback state, and drives the
// AudioEngine. The queue is client-side session state; persistent server state
// (stars, play counts via scrobble) is written through the API so other clients
// stay in sync.

import { batch, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { Song } from "~/api/types";
import { client } from "~/auth/session";
import { settings } from "~/settings/store";
import { AudioEngine, type DeckTrack } from "./engine";

export type RepeatMode = "off" | "all" | "one";

interface PlayerState {
  queue: Song[];
  index: number; // -1 when nothing loaded
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number; // 0..1
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
}

const QUEUE_KEY = "nd:queue";

function createPlayer() {
  const [state, setState] = createStore<PlayerState>({
    queue: [],
    index: -1,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: settings.playback.defaultVolume / 100,
    muted: false,
    shuffle: false,
    repeat: "off",
  });

  // Tracks whether we've submitted a scrobble for the current track yet.
  const [scrobbled, setScrobbled] = createSignal(false);

  const engine = new AudioEngine({
    onProgress: (time, duration) => {
      setState({ currentTime: time, duration });
      maybeScrobble(time, duration);
    },
    onEnded: () => advance(true),
    onPlayingChange: (playing) => setState("isPlaying", playing),
    onCrossfadeStart: () => {
      // The next track is now audibly active; advance queue state to match.
      advanceIndexOnly();
    },
  });
  engine.setVolume(state.volume);
  engine.setCrossfade(settings.playback.crossfadeSeconds);

  function current(): Song | undefined {
    return state.queue[state.index];
  }

  function replayGainDb(song: Song): number {
    const mode = settings.playback.replayGain.mode;
    if (mode === "off" || !song.replayGain) return 0;
    const base = mode === "album" ? song.replayGain.albumGain : song.replayGain.trackGain;
    return (base ?? 0) + settings.playback.replayGain.preAmpDb;
  }

  function deckTrack(song: Song): DeckTrack {
    const c = client();
    const maxBitRate = settings.playback.maxBitRate || undefined;
    return {
      url: c ? c.streamUrl(song.id, maxBitRate) : "",
      replayGainDb: replayGainDb(song),
      peak:
        settings.playback.replayGain.mode === "album"
          ? song.replayGain?.albumPeak ?? 1
          : song.replayGain?.trackPeak ?? 1,
    };
  }

  async function playSongAt(index: number): Promise<void> {
    const song = state.queue[index];
    if (!song) return;
    setState("index", index);
    setScrobbled(false);
    await engine.play(deckTrack(song));
    notifyNowPlaying(song);
    prefetchNext();
  }

  // Preload the upcoming track so gapless/crossfade is ready.
  function prefetchNext(): void {
    if (!settings.power.prefetch.enabled) {
      engine.prepareNext(null);
      return;
    }
    const next = peekNextIndex();
    if (next === null) {
      engine.prepareNext(null);
      return;
    }
    engine.prepareNext(deckTrack(state.queue[next]));
  }

  function peekNextIndex(): number | null {
    if (state.queue.length === 0) return null;
    if (state.repeat === "one") return state.index;
    if (state.index < state.queue.length - 1) return state.index + 1;
    if (state.repeat === "all") return 0;
    return null;
  }

  function peekPrevIndex(): number | null {
    if (state.queue.length === 0) return null;
    if (state.index > 0) return state.index - 1;
    if (state.repeat === "all") return state.queue.length - 1;
    return null;
  }

  // --- Public actions ---

  function playNow(songs: Song[], startIndex = 0): void {
    if (songs.length === 0) return;
    let queue = songs;
    let index = startIndex;
    if (state.shuffle) {
      // Keep the chosen track first, shuffle the rest.
      const chosen = songs[startIndex];
      const rest = songs.filter((_, i) => i !== startIndex);
      shuffleInPlace(rest);
      queue = [chosen, ...rest];
      index = 0;
    }
    setState({ queue: [...queue], index: -1 });
    void playSongAt(index);
    persistQueue();
  }

  function addToQueue(songs: Song[]): void {
    setState("queue", (q) => [...q, ...songs]);
    if (state.index === -1 && state.queue.length > 0) {
      void playSongAt(0);
    } else {
      prefetchNext();
    }
    persistQueue();
  }

  function playNext(songs: Song[]): void {
    setState("queue", (q) => {
      const copy = [...q];
      copy.splice(state.index + 1, 0, ...songs);
      return copy;
    });
    prefetchNext();
    persistQueue();
  }

  function removeAt(index: number): void {
    if (index < 0 || index >= state.queue.length) return;
    const wasCurrent = index === state.index;
    setState("queue", (q) => q.filter((_, i) => i !== index));
    if (index < state.index) setState("index", (i) => i - 1);
    if (wasCurrent) {
      if (state.queue.length === 0) {
        stop();
      } else {
        void playSongAt(Math.min(state.index, state.queue.length - 1));
      }
    } else {
      prefetchNext();
    }
    persistQueue();
  }

  function moveInQueue(from: number, to: number): void {
    setState("queue", (q) => {
      const copy = [...q];
      const [item] = copy.splice(from, 1);
      copy.splice(to, 0, item);
      return copy;
    });
    // Keep index pointing at the same song.
    const cur = state.index;
    let newIndex = cur;
    if (from === cur) newIndex = to;
    else if (from < cur && to >= cur) newIndex = cur - 1;
    else if (from > cur && to <= cur) newIndex = cur + 1;
    setState("index", newIndex);
    prefetchNext();
    persistQueue();
  }

  function clearQueue(): void {
    stop();
    setState({ queue: [], index: -1 });
    persistQueue();
  }

  function togglePlay(): void {
    if (state.index === -1) {
      if (state.queue.length > 0) void playSongAt(0);
      return;
    }
    if (state.isPlaying) engine.pause();
    else engine.resume();
  }

  function next(): void {
    advance(false);
  }

  function previous(): void {
    // Restart current track if we're more than 3s in.
    if (engine.getCurrentTime() > 3) {
      engine.seek(0);
      return;
    }
    const prev = peekPrevIndex();
    if (prev !== null) void playSongAt(prev);
    else engine.seek(0);
  }

  // Advance to the next track. `natural` is true when the current track ended on
  // its own (respects repeat-one); false for an explicit skip.
  function advance(natural: boolean): void {
    if (natural && state.repeat === "one") {
      void playSongAt(state.index);
      return;
    }
    const n = peekNextIndex();
    if (n === null) {
      stop();
      return;
    }
    void playSongAt(n);
  }

  // Used when a crossfade has already started audio for the next track: move the
  // index/state without re-triggering playback.
  function advanceIndexOnly(): void {
    const n = peekNextIndex();
    if (n === null) return;
    batch(() => {
      setState("index", n);
      setScrobbled(false);
    });
    const song = state.queue[n];
    if (song) notifyNowPlaying(song);
    prefetchNext();
  }

  function stop(): void {
    engine.stop();
    setState({ isPlaying: false, currentTime: 0, duration: 0 });
  }

  function seek(time: number): void {
    engine.seek(time);
    setState("currentTime", time);
  }

  function seekBy(delta: number): void {
    seek(engine.getCurrentTime() + delta);
  }

  function setVolume(v: number): void {
    const vol = Math.max(0, Math.min(1, v));
    engine.setVolume(vol);
    setState({ volume: vol, muted: false });
    engine.setMuted(false);
  }

  function changeVolume(delta: number): void {
    setVolume(state.volume + delta);
  }

  function toggleMute(): void {
    const m = !state.muted;
    engine.setMuted(m);
    setState("muted", m);
  }

  function toggleShuffle(): void {
    setState("shuffle", (s) => !s);
  }

  function cycleRepeat(): void {
    const order: RepeatMode[] = ["off", "all", "one"];
    setState("repeat", (r) => order[(order.indexOf(r) + 1) % order.length]);
    prefetchNext();
  }

  // --- Scrobbling ---

  function notifyNowPlaying(song: Song): void {
    if (!settings.playback.scrobble) return;
    client()?.scrobble(song.id, false).catch(() => {});
  }

  function maybeScrobble(time: number, duration: number): void {
    if (scrobbled() || !settings.playback.scrobble) return;
    if (duration <= 0) return;
    // Last.fm-style: submit after 4 minutes or half the track, whichever first.
    const threshold = Math.min(duration / 2, 240);
    if (time >= threshold) {
      const song = current();
      if (song) {
        setScrobbled(true);
        client()?.scrobble(song.id, true).catch(() => {});
      }
    }
  }

  // --- Persistence (queue only; server owns durable state) ---

  function persistQueue(): void {
    if (!settings.playback.resumeQueueOnLaunch) return;
    try {
      localStorage.setItem(
        QUEUE_KEY,
        JSON.stringify({ queue: state.queue, index: state.index }),
      );
    } catch {
      // ignore quota errors
    }
  }

  function restoreQueue(): void {
    if (!settings.playback.resumeQueueOnLaunch) return;
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { queue: Song[]; index: number };
      if (Array.isArray(data.queue) && data.queue.length > 0) {
        // Load without auto-playing (autoplay needs a gesture anyway).
        setState({ queue: data.queue, index: Math.max(0, Math.min(data.index, data.queue.length - 1)) });
      }
    } catch {
      // ignore
    }
  }

  return {
    state,
    playNow,
    addToQueue,
    playNext,
    removeAt,
    moveInQueue,
    clearQueue,
    togglePlay,
    next,
    previous,
    stop,
    seek,
    seekBy,
    setVolume,
    changeVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    current,
    restoreQueue,
    syncCrossfade: () => engine.setCrossfade(settings.playback.crossfadeSeconds),
  };
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Single app-wide player instance, owned by a root so reactivity has an owner.
export const player = createRoot(createPlayer);
