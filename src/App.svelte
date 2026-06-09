<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Timeline from './lib/components/Timeline.svelte';
  import TimeAxis from './lib/components/TimeAxis.svelte';
  import { timeline } from './lib/timeline/store.svelte';
  import { hms } from './lib/timeline/format';

  // ---- local UI state --------------------------------------------------
  // A ticking "now" used for the seek slider max and the datetime-local max.
  let nowMs = $state(Date.now());

  let composer = $state('');
  // 'current' publishes anchored to wall-clock now; 'playback' is the intent to
  // anchor to the playhead position. The real publish path only supports now.
  let postMode = $state<'current' | 'playback'>('current');
  let posting = $state(false);

  const SPEED_OPTIONS = [1.0, 1.2, 1.5, 2.0];
  const WINDOW_OPTIONS = [
    { ms: 60_000, label: '1 min' },
    { ms: 300_000, label: '5 min' },
    { ms: 900_000, label: '15 min' },
    { ms: 1_800_000, label: '30 min' },
    { ms: 3_600_000, label: '1 hour' },
  ];

  // ---- derived display -------------------------------------------------
  const modeLabel = $derived(
    timeline.mode === 'follows' ? 'follows mode' : 'limited mode',
  );
  const statusLabel = $derived(
    {
      idle: 'idle',
      connecting: 'connecting…',
      live: 'live',
      limited: 'limited',
      error: 'error',
    }[timeline.status],
  );
  const rightEdgeLabel = $derived(
    timeline.isLive ? 'now (LIVE)' : hms(timeline.playheadMs),
  );
  // window.nostr availability is reflected by canPost (set during connect()).
  const canPost = $derived(timeline.canPost);

  // ---- helpers ---------------------------------------------------------
  /** epoch-ms -> value string for <input type="datetime-local"> (local time). */
  function toLocalInput(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function onSpeedChange(e: Event): void {
    timeline.setSpeed(Number((e.currentTarget as HTMLSelectElement).value));
  }

  function onWindowChange(e: Event): void {
    const ms = Number((e.currentTarget as HTMLSelectElement).value);
    if (Number.isFinite(ms) && ms > 0) timeline.windowMs = ms;
  }

  function onSeekInput(e: Event): void {
    timeline.seekTo(Number((e.currentTarget as HTMLInputElement).value));
  }

  function onJump(e: Event): void {
    const raw = (e.currentTarget as HTMLInputElement).value;
    if (!raw) return;
    const ms = new Date(raw).getTime();
    if (Number.isFinite(ms)) timeline.seekTo(ms);
  }

  async function submitPost(): Promise<void> {
    const text = composer.trim();
    if (!text || posting || !canPost) return;
    posting = true;
    try {
      // The publish path always stamps the note at the real current time, so a
      // 'playback'-anchored post is still published now (see limitation note).
      await timeline.post(text);
      composer = '';
      if (postMode === 'current') timeline.goLive();
    } catch {
      // timeline.error already carries the message; surfaced in the banner.
    } finally {
      posting = false;
    }
  }

  function onComposerKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void submitPost();
    }
  }

  // ---- lifecycle -------------------------------------------------------
  let nowTimer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    nowTimer = setInterval(() => {
      nowMs = Date.now();
    }, 250);
    // Connect on mount: opens relay sockets, fetches history, subscribes live.
    void timeline.connect();
  });

  onDestroy(() => {
    if (nowTimer) clearInterval(nowTimer);
    // Disconnect on destroy: closes all relay subscriptions and stops the loop.
    timeline.disconnect();
  });
</script>

<main class="app">
  <header class="topbar">
    <div class="brand">
      <span class="logo">▶</span>
      <span class="title">nosplay</span>
    </div>
    <div class="status" class:error={timeline.status === 'error'}>
      <span class="dot" data-status={timeline.status}></span>
      <span>{statusLabel}</span>
      <span class="sep">·</span>
      <span>{modeLabel}</span>
      <span class="sep">·</span>
      <span class="edge" title="The right edge of the timeline/axis is the current time">
        right edge = {rightEdgeLabel}
      </span>
    </div>
  </header>

  {#if timeline.error}
    <div class="banner" role="alert">{timeline.error}</div>
  {/if}

  <!-- The timeline fills all remaining space; right edge = current time. -->
  <Timeline />
  <TimeAxis />

  <section class="controls" aria-label="Playback controls">
    <!-- seek slider: left = earliest known note, right edge = now -->
    <div class="seek-row">
      <span class="edge-label">past</span>
      <input
        class="seek"
        type="range"
        min={timeline.earliestMs}
        max={nowMs}
        step="1000"
        value={timeline.playheadMs}
        oninput={onSeekInput}
        aria-label="Seek playhead"
      />
      <span class="edge-label now">now</span>
    </div>

    <div class="control-row">
      <div class="group">
        <button
          class="primary"
          onclick={() => timeline.togglePlay()}
          aria-label={timeline.isPlaying ? 'Pause' : 'Play'}
        >
          {timeline.isPlaying ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button onclick={() => timeline.nudge(-60_000)} title="Back 1 minute">−1m</button>
        <button onclick={() => timeline.nudge(60_000)} title="Forward 1 minute">+1m</button>
        <button class:active={timeline.isLive} onclick={() => timeline.goLive()}>● LIVE</button>
      </div>

      <div class="group">
        <label class="field">
          <span>Speed</span>
          <select value={String(timeline.speed)} onchange={onSpeedChange}>
            {#each SPEED_OPTIONS as s (s)}
              <option value={String(s)}>{s.toFixed(1)}×</option>
            {/each}
          </select>
        </label>

        <label class="field">
          <span>Recent window</span>
          <select value={String(timeline.windowMs)} onchange={onWindowChange}>
            {#each WINDOW_OPTIONS as w (w.ms)}
              <option value={String(w.ms)}>{w.label}</option>
            {/each}
          </select>
        </label>

        <label class="field">
          <span>Jump to</span>
          <input
            type="datetime-local"
            value={toLocalInput(timeline.playheadMs)}
            max={toLocalInput(nowMs)}
            onchange={onJump}
          />
        </label>
      </div>

      <div class="group right">
        <button
          class:active={timeline.ttsEnabled}
          onclick={() => timeline.toggleTts()}
          title="Read new notes aloud"
        >
          🔊 TTS {timeline.ttsEnabled ? 'on' : 'off'}
        </button>
      </div>
    </div>

    <!-- composer at the very bottom -->
    <div class="composer-row">
      <textarea
        class="composer"
        bind:value={composer}
        placeholder={canPost
          ? 'Write a note… (⌘/Ctrl+Enter to post)'
          : 'Install a NIP-07 extension (window.nostr) to post'}
        rows="1"
        disabled={!canPost || posting}
        onkeydown={onComposerKey}
      ></textarea>
      <label class="field">
        <span>Post @</span>
        <select bind:value={postMode}>
          <option value="current">current time</option>
          <option value="playback">playback position</option>
        </select>
      </label>
      <button
        class="primary"
        onclick={submitPost}
        disabled={!canPost || posting || composer.trim().length === 0}
      >
        {posting ? 'Posting…' : 'Post'}
      </button>
    </div>

    {#if postMode === 'playback'}
      <div class="hint" role="note">
        Note: Nostr notes are always published at the real current time. This
        build cannot back-date a note to the playback position
        ({hms(timeline.playheadMs)}); it will be posted at now.
      </div>
    {/if}
  </section>
</main>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  .topbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px;
    background: var(--bg-2);
    border-bottom: 1px solid var(--border);
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .brand .logo {
    color: var(--accent);
    font-size: 16px;
  }
  .brand .title {
    color: var(--text-h);
    font-weight: 700;
    letter-spacing: 0.5px;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-dim);
  }
  .status.error {
    color: var(--live);
  }
  .status .sep {
    opacity: 0.4;
  }
  .status .edge {
    color: var(--text-h);
  }
  .status .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-dim);
  }
  .status .dot[data-status='live'] {
    background: var(--ok);
    box-shadow: 0 0 6px var(--ok);
  }
  .status .dot[data-status='limited'] {
    background: var(--accent);
  }
  .status .dot[data-status='connecting'] {
    background: #e0b341;
  }
  .status .dot[data-status='error'] {
    background: var(--live);
  }

  .banner {
    flex: 0 0 auto;
    padding: 6px 14px;
    background: rgba(255, 77, 109, 0.12);
    border-bottom: 1px solid var(--live);
    color: var(--live);
    font-size: 13px;
  }

  .controls {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px 14px;
    background: var(--bg-2);
    border-top: 1px solid var(--border);
  }

  .seek-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .edge-label {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
    flex: 0 0 auto;
  }
  .edge-label.now {
    color: var(--live);
    font-weight: 700;
  }
  .seek {
    flex: 1 1 auto;
    accent-color: var(--accent);
    height: 4px;
  }

  .control-row {
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .group.right {
    margin-left: auto;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .field span {
    white-space: nowrap;
  }

  .primary {
    background: var(--accent-bg);
    border-color: var(--accent-border);
    color: var(--accent);
    font-weight: 600;
  }
  .primary:hover:not(:disabled) {
    background: rgba(192, 132, 252, 0.25);
  }

  .composer-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .composer {
    flex: 1 1 auto;
    resize: none;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px;
    line-height: 1.4;
    min-height: 38px;
    max-height: 120px;
  }
  .composer:focus {
    outline: none;
    border-color: var(--accent-border);
  }
  .hint {
    font-size: 12px;
    color: var(--text-dim);
    line-height: 1.4;
  }

  select,
  input[type='datetime-local'] {
    color-scheme: dark;
  }
</style>
