// Playback store: owns the queue and reactive playback state, and drives the
// AudioEngine. The queue is client-side session state; persistent server state
// (stars, play counts via scrobble) is written through the API so other clients
// stay in sync.

import { batch, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { Song } from "~/api/types";
import type { StreamHandle } from "~/api/MusicClient";
import { client } from "~/auth/session";
import { settings } from "~/settings/store";
import { proxyMode } from "~/lib/serverConfig";
import { canPlayContainer } from "~/lib/codecs";
import { nextRadioBatch } from "~/lib/recommendations";
import { AudioEngine, type DeckTrack } from "./engine";

// Whether the browser can decode this track as stored. Delegates to the shared
// codec probe so the player and the Jellyfin device profile can never disagree
// about what needs transcoding.
export function isFormatSupported(song: Song): boolean {
  return canPlayContainer(song.contentType || song.suffix, song.codec);
}

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

  // Position (seconds) to resume the restored track at, applied on first play
  // after a refresh. Cleared once consumed.
  let resumeAt = 0;
  // Throttle position persistence during playback.
  let lastPersist = 0;

  // The negotiated stream backing the currently-playing track. Carries the
  // Jellyfin PlaySessionId, so progress and stop reports land on the right
  // server-side playback and its encoder is released when we're done.
  let activeStream: StreamHandle | null = null;
  // The song `activeStream` belongs to, so a stop report can still name it after
  // the queue index has moved on.
  let activeSong: Song | null = null;
  // The prefetched next track and its negotiated stream. A crossfade starts the
  // idle deck without going through playSongAt, so these get promoted to
  // active/* when that happens — otherwise the crossfaded track would be
  // reported with the previous track's session id.
  let pendingSong: Song | null = null;
  let pendingStream: StreamHandle | null = null;
  let pendingDeck: DeckTrack | null = null;
  // Last time a progress report was sent (performance.now()).
  let lastProgressReport = 0;
  // Whether the server has been told playback started for `activeSong`. Progress
  // and pause reports before that would open a session out of order.
  let startReported = false;
  // Guards the "the browser couldn't decode this" retry so a genuinely broken
  // track is skipped instead of looping.
  let transcodeRetryFor: string | null = null;
  // Monotonic token so a slow stream negotiation for a track the user has
  // already skipped past can't hijack playback.
  let playToken = 0;

  const PROGRESS_REPORT_MS = 10_000;

  // Sleep timer: null = off, "end" = stop when the current track finishes, or a
  // number = epoch-ms deadline at which playback pauses.
  const [sleepMode, setSleepMode] = createSignal<null | "end" | number>(null);
  let sleepTimeout: ReturnType<typeof setTimeout> | undefined;

  const engine = new AudioEngine({
    onProgress: (time, duration) => {
      // Transcoded/streamed responses often report a non-finite element
      // duration, which the engine passes through as 0. Don't let that clobber
      // the track length we seeded from metadata — only accept a real value.
      if (duration > 0) {
        setState({ currentTime: time, duration });
      } else {
        setState("currentTime", time);
      }
      maybeScrobble(time, duration > 0 ? duration : state.duration);
      maybeReportProgress(time);
      // Persist position periodically so a refresh resumes where you were.
      if (settings.playback.resumeQueueOnLaunch && performance.now() - lastPersist > 4000) {
        lastPersist = performance.now();
        persistQueue();
      }
    },
    onEnded: () => {
      // Report the stop *before* advancing, while the finished track is still
      // the active one: on Jellyfin this is what banks the play count and
      // clears the resume position.
      reportStop(state.currentTime);
      advance(true);
    },
    onPlayingChange: (playing) => {
      setState("isPlaying", playing);
      // Push the pause/unpause straight through rather than waiting for the next
      // progress tick, so a Jellyfin remote reflects it immediately.
      reportEvent(playing ? "progress" : "pause", engine.getCurrentTime());
    },
    onCrossfadeStart: () => {
      // The outgoing track finished as far as the server is concerned.
      reportStop(state.currentTime);
      // The next track is now audibly active; advance queue state to match.
      advanceIndexOnly();
    },
    onError: (code) => {
      const song = current();
      if (!song) return;
      // MEDIA_ERR_DECODE (3) / SRC_NOT_SUPPORTED (4): the browser can't handle
      // what the server sent. Ask for a transcode once before giving up — this
      // covers containers our probe was optimistic about.
      if ((code === 3 || code === 4) && transcodeRetryFor !== song.id) {
        transcodeRetryFor = song.id;
        void playSongAt(state.index, engine.getCurrentTime(), { forceTranscode: true });
        return;
      }
      // Unplayable: don't strand the queue on it.
      advance(true);
    },
    onSeekUnsupported: (time) => {
      // Live radio has no timeline to seek within; restarting the stream would
      // just interrupt it.
      if (current()?.isRadio) return;
      // A live transcode: reopen the stream at the requested offset instead of
      // moving currentTime, which would land at an arbitrary point.
      setState("currentTime", time);
      void playSongAt(state.index, time, { keepScrobbleState: true });
    },
  });
  engine.setVolume(state.volume);
  engine.setCrossfade(settings.playback.crossfadeSeconds);
  // Apply the saved equalizer state. If it was left enabled, the Web Audio graph
  // is built up front so it's ready for the first track.
  syncEqualizer();

  function syncEqualizer(): boolean {
    const eq = settings.playback.equalizer;
    return engine.setEqualizer({
      enabled: eq.enabled,
      preampDb: eq.preampDb,
      gains: eq.gains,
    });
  }

  function current(): Song | undefined {
    return state.queue[state.index];
  }

  function replayGainDb(song: Song): number {
    const mode = settings.playback.replayGain.mode;
    if (mode === "off" || !song.replayGain) return 0;
    const base = mode === "album" ? song.replayGain.albumGain : song.replayGain.trackGain;
    return (base ?? 0) + settings.playback.replayGain.preAmpDb;
  }

  function peakFor(song: Song): number {
    return settings.playback.replayGain.mode === "album"
      ? (song.replayGain?.albumPeak ?? 1)
      : (song.replayGain?.trackPeak ?? 1);
  }

  // Ask the backend for a playable stream.
  //
  // Subsonic answers instantly from the credentials it already holds; Jellyfin
  // does a real negotiation round-trip (PlaybackInfo) that decides direct play
  // vs transcode and mints the PlaySessionId. Either way the caller gets back
  // both the DeckTrack the engine needs and the handle the reporter needs.
  async function resolveDeck(
    song: Song,
    opts: { startSeconds?: number; forceTranscode?: boolean } = {},
  ): Promise<{ deck: DeckTrack; stream: StreamHandle | null }> {
    // External sources (live radio) carry their own stream URL; no negotiation,
    // transcoding or ReplayGain applies.
    if (song.streamUrl) {
      return {
        deck: { url: song.streamUrl, replayGainDb: 0, peak: 1, canSeek: false },
        stream: null,
      };
    }
    const c = client();
    if (!c) return { deck: { url: "", replayGainDb: 0, peak: 1 }, stream: null };

    const streamOpts = {
      maxBitRateKbps: settings.playback.maxBitRate || undefined,
      startSeconds: opts.startSeconds,
      // Force a transcode when the browser has already choked on this source,
      // or when our capability probe says it never had a chance.
      forceTranscode: opts.forceTranscode || !isFormatSupported(song),
    };

    let stream: StreamHandle;
    try {
      stream = await c.resolveStream(song.id, streamOpts);
    } catch {
      // Negotiation failed (offline, server hiccup): fall back to the plain URL
      // so playback still has a chance rather than failing outright.
      stream = {
        url: c.streamUrl(
          song.id,
          streamOpts.maxBitRateKbps,
          streamOpts.forceTranscode ? "mp3" : undefined,
        ),
        canSeek: true,
        startOffset: 0,
      };
    }

    return {
      deck: {
        url: stream.url,
        replayGainDb: replayGainDb(song),
        peak: peakFor(song),
        startOffset: stream.startOffset,
        canSeek: stream.canSeek,
        duration: stream.duration ?? song.duration,
      },
      stream,
    };
  }

  async function playSongAt(
    index: number,
    startAt = 0,
    opts: { forceTranscode?: boolean; keepScrobbleState?: boolean } = {},
  ): Promise<void> {
    const song = state.queue[index];
    if (!song) return;

    // Close out whatever was playing before, so the server frees its encoder and
    // records where we got to. This applies even when it's the same track: a
    // repeat or a seek-restart opens a brand-new server-side stream, and the old
    // one has to be released rather than left running.
    if (activeSong) reportStop(engine.getCurrentTime());

    const token = ++playToken;
    // Seed time + length from metadata immediately so the UI is correct for the
    // new track before (and even if) the element reports its own duration.
    setState({ index, currentTime: startAt, duration: song.duration ?? 0 });
    if (!opts.keepScrobbleState) setScrobbled(false);
    if (!opts.forceTranscode) transcodeRetryFor = null;

    // Advancing onto the track we already prefetched: reuse that exact stream.
    // Re-negotiating would mint a different URL, so the engine wouldn't
    // recognise the preloaded deck and would throw the buffered audio away —
    // and on Jellyfin it would leave an orphaned encoder behind.
    const prefetched =
      !opts.forceTranscode && startAt === 0 && pendingSong?.id === song.id && pendingDeck
        ? { deck: pendingDeck, stream: pendingStream }
        : null;
    if (prefetched) {
      pendingSong = null;
      pendingStream = null;
      pendingDeck = null;
    }

    const { deck, stream } =
      prefetched ??
      (await resolveDeck(song, {
        startSeconds: startAt,
        forceTranscode: opts.forceTranscode,
      }));
    // The user moved on while we were negotiating — drop this result.
    if (token !== playToken) return;

    activeStream = stream;
    activeSong = song;
    startReported = false;
    lastProgressReport = 0;

    await engine.play(deck);

    // Resume from a saved position. When the server already applied the offset
    // (a transcode restarted at startTimeTicks) the stream is *at* that point
    // and seeking again would be wrong.
    if (startAt > 0 && (deck.startOffset ?? 0) === 0 && engine.isSeekable()) {
      engine.seek(startAt);
    }

    notifyNowPlaying(song);
    prefetchNext();
    void maybeTopUpRadio();
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
    const song = state.queue[next];
    // Repeat-one preloads the track that's already playing. On Jellyfin that
    // means a second negotiation for the same item while the first is live —
    // pointless work, and on the transcode path two encodes racing each other.
    // The engine replays the active deck for repeat-one anyway.
    if (!song || song.id === current()?.id) {
      engine.prepareNext(null);
      releasePrefetched();
      return;
    }
    // Already queued up: leave it alone. prefetchNext() runs on every queue
    // edit, and re-resolving would mint a fresh stream (and, on Jellyfin, a
    // fresh encoder) for a track we've already buffered.
    if (pendingSong?.id === song.id && pendingDeck) {
      engine.prepareNext(pendingDeck);
      return;
    }
    releasePrefetched();
    const token = playToken;
    void resolveDeck(song).then(({ deck, stream }) => {
      // Don't install a prefetch that resolved after the queue moved on.
      if (token !== playToken) return;
      engine.prepareNext(deck);
      pendingSong = song;
      pendingStream = stream;
      pendingDeck = deck;
    });
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
    if (state.isPlaying) {
      engine.pause();
    } else {
      if (!engine.hasActiveTrack()) {
        // First play after a restore: resume at the saved position.
        const at = resumeAt;
        resumeAt = 0;
        void playSongAt(state.index, at);
      } else {
        engine.resume();
      }
    }
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
    // Sleep timer set to "end of track": stop here instead of advancing.
    if (natural && sleepMode() === "end") {
      fireSleep();
      return;
    }
    if (natural && state.repeat === "one") {
      void playSongAt(state.index);
      return;
    }
    const n = peekNextIndex();
    if (n === null) {
      // Queue exhausted: optionally keep going with similar tracks (autoplay).
      if (natural && settings.playback.autoplay) {
        void autoplayContinue();
        return;
      }
      stop();
      return;
    }
    void playSongAt(n);
  }

  // Infinite radio: when the queue runs out, append tracks similar to the last
  // one played and continue. With proactive top-up below this rarely fires; it's
  // the safety net for when a background fetch failed. Stops if nothing's left.
  async function autoplayContinue(): Promise<void> {
    const seed = current();
    const c = client();
    if (!seed || !c || seed.isRadio) {
      stop();
      return;
    }
    const at = state.queue.length;
    const added = await fetchRadioTracks(seed.id, 25);
    if (added === 0) {
      stop();
      return;
    }
    void playSongAt(at);
  }

  // Guards against overlapping background fetches when several advances land in
  // quick succession.
  let radioFetching = false;
  // Top up before the queue empties: once only this many tracks remain after the
  // current one, fetch more in the background so playback stays seamless.
  const RADIO_THRESHOLD = 2;

  // Proactive radio: if infinite radio is on and the queue is nearly exhausted,
  // append more similar tracks ahead of time. Fire-and-forget; failures are
  // retried on the next advance.
  async function maybeTopUpRadio(): Promise<void> {
    if (!settings.playback.autoplay || radioFetching || state.index < 0) return;
    const remaining = state.queue.length - 1 - state.index;
    if (remaining > RADIO_THRESHOLD) return;
    const seed = state.queue[state.queue.length - 1];
    if (!seed || seed.isRadio) return;
    await fetchRadioTracks(seed.id, 15);
  }

  // Fetch songs similar to `seedId`, drop ones already queued, apply discovery
  // filters, append the result, and return how many were added.
  async function fetchRadioTracks(seedId: string, count: number): Promise<number> {
    const c = client();
    if (!c) return 0;
    radioFetching = true;
    try {
      const similar = await c.getSimilarSongs(seedId, count);
      const fresh = nextRadioBatch(state.queue, similar);
      if (fresh.length === 0) return 0;
      setState("queue", (q) => [...q, ...fresh]);
      persistQueue();
      prefetchNext();
      return fresh.length;
    } catch {
      return 0;
    } finally {
      radioFetching = false;
    }
  }

  // --- Sleep timer ---

  function clearSleepTimeout(): void {
    if (sleepTimeout) clearTimeout(sleepTimeout);
    sleepTimeout = undefined;
  }

  // Clear the timer and stop playback when the sleep deadline hits. Playback
  // fades out gently — unless the user prefers reduced motion, then it just pauses.
  function fireSleep(): void {
    clearSleepTimeout();
    setSleepMode(null);
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) engine.pause();
    else engine.fadeOutAndPause(5);
  }

  // minutes > 0 → pause after that long; "end" → pause when the track finishes;
  // null → cancel.
  function setSleepTimer(mode: number | "end" | null): void {
    clearSleepTimeout();
    if (mode === null) {
      setSleepMode(null);
      return;
    }
    if (mode === "end") {
      setSleepMode("end");
      return;
    }
    const ms = mode * 60_000;
    setSleepMode(Date.now() + ms);
    sleepTimeout = setTimeout(fireSleep, ms);
  }

  // Used when a crossfade has already started audio for the next track: move the
  // index/state without re-triggering playback.
  function advanceIndexOnly(): void {
    const n = peekNextIndex();
    if (n === null) return;
    const next = state.queue[n];
    batch(() => {
      setState({ index: n, currentTime: 0, duration: next?.duration ?? 0 });
      setScrobbled(false);
    });
    // The deck that just faded in is the one we prefetched, so adopt its
    // negotiated stream as the active one.
    activeSong = pendingSong ?? next ?? null;
    activeStream = pendingStream;
    pendingSong = null;
    pendingStream = null;
    pendingDeck = null;
    startReported = false;
    lastProgressReport = 0;
    if (next) notifyNowPlaying(next);
    prefetchNext();
    void maybeTopUpRadio();
  }

  function stop(): void {
    reportStop(engine.getCurrentTime());
    engine.stop();
    setState({ isPlaying: false, currentTime: 0, duration: 0 });
  }

  function seek(time: number): void {
    engine.seek(time);
    setState("currentTime", time);
    // Tell the server where we jumped to; on Jellyfin this keeps the remote's
    // scrubber and the resume point honest.
    reportEvent("progress", time);
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

  // --- Playback reporting ---
  //
  // Two protocols hide behind one set of calls:
  //
  //   Subsonic  — a now-playing ping on start, and one submission scrobble once
  //               the listen threshold is crossed. Progress isn't a concept.
  //   Jellyfin  — a real session: start, periodic progress, and a single stop at
  //               the end. The *stop* is what banks the play count and clears
  //               the resume point, which is why it must never be sent
  //               mid-track. (Sending it halfway also drops the track from the
  //               server's Now Playing and leaves a bogus resume position.)

  function reportBase(position: number) {
    return {
      positionSeconds: Math.max(0, position),
      durationSeconds: state.duration || undefined,
      isPaused: !state.isPlaying,
      isMuted: state.muted,
      volume: state.volume,
      repeat: state.repeat,
      shuffle: state.shuffle,
      queue: state.queue.slice(state.index, state.index + 20).map((s) => ({ id: s.id })),
    };
  }

  function reportEvent(event: "start" | "progress" | "pause", position: number): void {
    const c = client();
    const song = activeSong;
    if (!c || !song || song.isRadio) return;
    if (!settings.playback.scrobble) return;
    if (event === "start") startReported = true;
    else if (!startReported) return;
    void c
      .reportPlayback(event, { songId: song.id, stream: activeStream ?? undefined, ...reportBase(position) })
      .catch(() => {});
  }

  // End the current server-side playback exactly once, then forget it.
  function reportStop(position: number): void {
    const c = client();
    const song = activeSong;
    activeSong = null;
    const stream = activeStream;
    activeStream = null;
    const wasStarted = startReported;
    startReported = false;
    if (!c || !song || song.isRadio || !wasStarted) return;
    if (!settings.playback.scrobble) return;
    void c
      .reportPlayback("stop", {
        songId: song.id,
        stream: stream ?? undefined,
        ...reportBase(position),
        isPaused: false,
      })
      .catch(() => {});
  }

  // Discard a prefetched stream that will never be played, releasing whatever
  // the server set up for it. Never reported as a "start", so this is purely a
  // teardown — Jellyfin keys the kill on the PlaySessionId.
  function releasePrefetched(): void {
    const c = client();
    const song = pendingSong;
    const stream = pendingStream;
    pendingSong = null;
    pendingStream = null;
    pendingDeck = null;
    if (!c || !song || song.isRadio || !stream?.playSessionId) return;
    void c
      .reportPlayback("stop", { songId: song.id, stream, positionSeconds: 0 })
      .catch(() => {});
  }

  function maybeReportProgress(time: number): void {
    if (client()?.playbackReporting !== "session") return;
    const now = performance.now();
    if (now - lastProgressReport < PROGRESS_REPORT_MS) return;
    lastProgressReport = now;
    reportEvent("progress", time);
  }

  function notifyNowPlaying(song: Song): void {
    if (song.isRadio) return; // not a library track — nothing to report
    if (!settings.playback.scrobble) return;
    reportEvent("start", state.currentTime);
  }

  function maybeScrobble(time: number, duration: number): void {
    // Jellyfin banks the play from the stop report, so a mid-track submission
    // here would double-count it (and, before this split, actively broke the
    // stream by ending the session).
    if (client()?.playbackReporting !== "scrobble") return;
    if (scrobbled() || !settings.playback.scrobble) return;
    if (duration <= 0) return;
    // Last.fm-style: submit after 4 minutes or half the track, whichever first.
    const threshold = Math.min(duration / 2, 240);
    if (time >= threshold) {
      const song = current();
      if (song && !song.isRadio) {
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
        JSON.stringify({ queue: state.queue, index: state.index, time: state.currentTime }),
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
      const data = JSON.parse(raw) as { queue: Song[]; index: number; time?: number };
      if (Array.isArray(data.queue) && data.queue.length > 0) {
        // Load without auto-playing (autoplay needs a gesture anyway). Remember
        // the saved position so the first play resumes where you left off.
        const index = Math.max(0, Math.min(data.index, data.queue.length - 1));
        const time = Math.max(0, data.time ?? 0);
        resumeAt = time;
        setState({ queue: data.queue, index, duration: data.queue[index]?.duration ?? 0, currentTime: time });
      }
    } catch {
      // ignore
    }
  }

  // Closing the tab should end the server-side playback, not leave a phantom
  // "now playing" and a running encoder behind. The stop report is sent with
  // keepalive so it survives teardown.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => reportStop(engine.getCurrentTime()));
    // Tauri's native application menu emits these actions. Keeping the mapping
    // beside the player means the desktop shell never needs access to library
    // credentials or playback internals.
    window.addEventListener("tonearm:native-shortcut", ((event: CustomEvent<string>) => {
      switch (event.detail) {
        case "play-pause": togglePlay(); break;
        case "previous": previous(); break;
        case "next": next(); break;
        case "volume-up": changeVolume(0.05); break;
        case "volume-down": changeVolume(-0.05); break;
      }
    }) as EventListener);
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
    // True when the current stream can be scrubbed in place. A server-side
    // transcode can still be "seeked" — it just reopens at the new offset.
    isSeekable: () => engine.isSeekable(),
    setVolume,
    changeVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    current,
    restoreQueue,
    syncCrossfade: () => engine.setCrossfade(settings.playback.crossfadeSeconds),
    syncEqualizer,
    equalizerAvailable: () => engine.isEqualizerAvailable(),
    // Build (if needed) and return the master analyser for the visualizer.
    // Building the graph forces CORS-clean stream reloads, which would break
    // playback when streams aren't same-origin — so only build it in proxy mode,
    // or reuse a graph the EQ already built (which proves CORS is fine). When it
    // returns null the visualizer falls back to a synthesized animation.
    enableVisualizer: (): AnalyserNode | null =>
      proxyMode() || engine.getAnalyser() ? engine.enableAnalyser() : null,
    sleepMode,
    setSleepTimer,
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
