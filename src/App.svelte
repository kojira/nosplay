<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Timeline from './lib/components/Timeline.svelte';
  import TimeAxis from './lib/components/TimeAxis.svelte';
  import { timeline } from './lib/timeline/store.svelte';
  import { hms, shortNpub } from './lib/timeline/format';
  import { parseShareParams, buildShareUrl } from './lib/share';
  import { aiBgVerdict } from './lib/timeline/store.svelte';
  import type { RelayMode } from './lib/timeline/store.svelte';

  // ---- local UI state --------------------------------------------------
  // A ticking "now" used for the seek slider max and the datetime-local max.
  let nowMs = $state(Date.now());

  let composer = $state('');
  // 'current' publishes anchored to wall-clock now; 'playback' is the intent to
  // anchor to the playhead position. The real publish path only supports now.
  let postMode = $state<'current' | 'playback'>('current');
  let posting = $state(false);

  const SPEED_OPTIONS = [1, 1.5, 2, 3, 5, 8, 10, 15, 20, 25, 30, 40, 50];
  /** Drop trailing ".0" so 1× / 1.5× / 20× all read cleanly. */
  function speedLabel(s: number): string {
    return `${Number.isInteger(s) ? s : s.toFixed(1)}×`;
  }
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

  // ---- AI summary background -------------------------------------------
  // A human-readable status line for the AI (Gemini Nano) background, shown
  // whenever the feature is toggled on so the user always knows what it's doing.
  const aiBgLabel = $derived.by(() => {
    switch (timeline.aiBgStatus) {
      case 'unsupported':
        return 'AI background: not supported — this browser has no built-in AI Prompt API (LanguageModel) to generate the SVG. No background is drawn.';
      case 'unavailable':
        return 'AI background: the on-device Gemini Nano model is unavailable on this device. No background is drawn.';
      case 'downloading':
        return `AI background: downloading Gemini Nano model… ${Math.round(timeline.aiBgProgress * 100)}%`;
      case 'ready':
        return timeline.aiBgSvg
          ? 'AI background: on — Gemini Nano is generating the SVG directly.'
          : 'AI background: ready — waiting for enough notes to generate an SVG.';
      case 'summarizing':
        return 'AI background: condensing the visible timeline for the SVG prompt…';
      case 'generating':
        return 'AI background: Gemini Nano is generating the background SVG…';
      case 'summary-empty':
        return 'AI background: nothing distinct enough to draw from yet.';
      case 'invalid-svg':
        return 'AI background: Gemini Nano returned SVG that failed strict validation — nothing was drawn (no fallback).';
      case 'error':
        return 'AI background: SVG generation could not run. Click the toggle again to grant model access / retry.';
      default:
        return 'AI background: off.';
    }
  });

  // Diagnostic snapshot of the last summarization run, surfaced in a compact,
  // collapsible debug panel so it's obvious where the current background came
  // from (which slice was summarized, scene vs deterministic, char budgets…).
  const aiDebug = $derived(timeline.aiBgDebug);
  const aiHasRun = $derived(aiDebug.lastRunAt > 0);
  const aiRenderLabel = $derived.by(() => {
    if (aiDebug.renderMode === 'direct-svg')
      return 'Gemini Nano direct SVG (validated)';
    if (aiDebug.failureReason) return `none — ${aiDebug.failureReason}`;
    return aiDebug.svgModelReady ? 'none — SVG model ready' : 'none — no SVG model';
  });
  const aiSliceLabel = $derived(
    aiDebug.sliceStartMs > 0
      ? `${hms(aiDebug.sliceStartMs)}–${hms(aiDebug.sliceEndMs)}`
      : '—',
  );
  const aiWindowLabel = $derived(
    aiHasRun ? `${hms(aiDebug.windowStartMs)}–${hms(aiDebug.windowEndMs)}` : '—',
  );

  // The headline YES/NO verdict: is SVG generation actually working, and did the
  // result make it onto the screen? Derived from the same snapshot the store
  // logs, so the panel and the console always agree.
  const aiVerdict = $derived(
    aiBgVerdict(aiDebug, timeline.aiBgSvg, timeline.aiBgEnabled),
  );
  // Compact DOM-layer summary (size · opacity · z-index) for the debug panel.
  const aiDomLabel = $derived(
    aiDebug.domCheckedAt === 0
      ? '—'
      : aiDebug.domInserted
        ? `${aiDebug.domWidth}×${aiDebug.domHeight} · opacity ${aiDebug.opacity} · z ${aiDebug.zIndex || 'auto'}`
        : 'not in DOM',
  );

  // ---- always-visible AI summary card ----------------------------------
  // One user-facing state for the summary shown on the main UI (not just the
  // collapsible debug panel). Reuses the same status + debug snapshot the panel
  // reads, so the card and the diagnostics never disagree. Four states:
  //  - 'available' the latest summary text is ready to show
  //  - 'empty'     a run happened but there wasn't enough/distinct text
  //  - 'waiting'   the model is up but the first run hasn't produced anything
  //  - 'failure'   the feature can't run (unsupported / unavailable / errored)
  type AiSummaryState = 'available' | 'empty' | 'waiting' | 'failure';
  const aiSummaryState = $derived.by<AiSummaryState>(() => {
    const s = timeline.aiBgStatus;
    // Hard blocks: the summary can never appear in these states.
    if (s === 'unsupported' || s === 'unavailable') return 'failure';
    // A summary we already have always wins over transient/SVG-only errors.
    if (timeline.aiBgSummary) return 'available';
    if (aiDebug.notEnoughText || s === 'summary-empty') return 'empty';
    if (s === 'invalid-svg' || s === 'error') return 'failure';
    if (!aiHasRun) return 'waiting';
    return 'empty';
  });
  // Short badge label + tone for each state (tone drives the accent colour).
  const aiSummaryBadge = $derived.by<{ label: string; tone: 'ok' | 'info' | 'warn' }>(() => {
    switch (aiSummaryState) {
      case 'available':
        return { label: 'Summary ready', tone: 'ok' };
      case 'empty':
        return { label: 'Not enough text', tone: 'info' };
      case 'waiting':
        return { label: 'Waiting for first run', tone: 'info' };
      case 'failure':
        return { label: 'Unavailable', tone: 'warn' };
    }
  });
  // Where/what was summarized, in human terms: counts + the created_at span of
  // the slice that fed the last run. Reuses aiSliceLabel (the source range).
  const aiSummaryMeta = $derived.by(() => {
    if (!aiHasRun) return 'No summary run yet.';
    const counts = `${aiDebug.summarizedCount} of ${aiDebug.visibleCount} visible notes`;
    return aiDebug.sliceStartMs > 0 ? `${counts} · ${aiSliceLabel}` : counts;
  });

  // ---- auth / follow / relay UI ---------------------------------------
  const loginLabel = $derived(
    {
      'logged-out': 'logged out',
      'logging-in': 'logging in…',
      'logged-in': 'logged in',
      'login-error': 'login error',
    }[timeline.loginState],
  );

  // A human explanation of how the current follow timeline was derived.
  const followExplain = $derived.by(() => {
    switch (timeline.followStatus) {
      case 'resolving':
        return 'Resolving your follows (kind:3) and read relays (kind:10002)…';
      case 'ready':
        return `Following ${timeline.followCount} accounts · timeline = people you follow.`;
      case 'empty':
        return 'No contact list (kind:3) found for this account — showing the limited feed instead.';
      case 'error':
        return 'Could not resolve your follows — showing the limited feed instead.';
      default:
        return 'Connect a NIP-07 signer to build a timeline from the accounts you follow.';
    }
  });

  // Relay settings panel (collapsible) + edit drafts.
  let showRelays = $state(false);
  let relayModeDraft = $state<RelayMode>(timeline.relayMode);
  let manualRelaysDraft = $state('');

  async function onLogin(): Promise<void> {
    try {
      await timeline.login();
    } catch {
      // loginError is surfaced in the account bar.
    }
  }

  function openRelays(): void {
    // Seed the editor from the live store each time it opens.
    relayModeDraft = timeline.relayMode;
    manualRelaysDraft = timeline.manualRelays.join('\n');
    showRelays = !showRelays;
  }

  async function applyRelays(): Promise<void> {
    const list = manualRelaysDraft.split('\n');
    await timeline.setRelaySettings(relayModeDraft, list);
    showRelays = false;
  }

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

  /** A human label for a voice option, e.g. "Kyoko (ja-JP)". */
  function voiceLabel(v: SpeechSynthesisVoice): string {
    return `${v.name} (${v.lang})`;
  }

  function onVoiceChange(e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    timeline.setVoice(v === '' ? null : v);
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

  // ---- share link ------------------------------------------------------
  // Transient confirmation shown after copying a share link; cleared on a timer.
  let shareNotice = $state('');
  let shareTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Copy a link to the current view range. The right edge (playhead, or now when
   * LIVE) is the end; the left edge (end − window) is the start. The link encodes
   * a fixed range, so a live view shares the moment it was captured.
   */
  async function onShare(): Promise<void> {
    const end = timeline.playheadMs;
    const url = buildShareUrl(end - timeline.windowMs, end);
    try {
      await navigator.clipboard.writeText(url);
      shareNotice = 'Link copied!';
    } catch {
      // Clipboard blocked (no permission / insecure context): show the URL so
      // the user can copy it manually.
      shareNotice = url;
    }
    if (shareTimer) clearTimeout(shareTimer);
    shareTimer = setTimeout(() => (shareNotice = ''), 4000);
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
    // A share link (?start=&end=) stages a view range that connect() applies on
    // top of persisted playback, so the link wins. Absent params, behavior is
    // unchanged. Stage before connect() so it is consumed during startup.
    const share = parseShareParams(window.location.search);
    if (share) timeline.applyShareRange(share);
    // Connect on mount: opens relay sockets, fetches history, subscribes live.
    void timeline.connect();
  });

  onDestroy(() => {
    if (nowTimer) clearInterval(nowTimer);
    if (shareTimer) clearTimeout(shareTimer);
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

  <!-- Account / NIP-07 login + follow timeline + relay settings -->
  <section class="account-bar" aria-label="Account and relays">
    <div class="acct-row">
      <div class="acct-login" data-login={timeline.loginState}>
        <span class="dot" data-login={timeline.loginState}></span>
        <span class="acct-label">NIP-07: {loginLabel}</span>
        {#if timeline.pubkey}
          <span class="pubkey" title={timeline.pubkey}>{shortNpub(timeline.pubkey)}</span>
        {/if}
      </div>

      <div class="acct-actions">
        {#if timeline.loginState === 'logged-in'}
          <button onclick={() => timeline.refreshFollows()} title="Re-fetch kind:3 + kind:10002">
            ↻ Refresh follows
          </button>
          <button onclick={() => timeline.reconnect()} title="Reconnect to relays">
            ⟳ Reconnect
          </button>
          <button onclick={() => timeline.logout()}>Log out</button>
        {:else}
          <button
            class="primary"
            onclick={onLogin}
            disabled={timeline.loginState === 'logging-in'}
          >
            {timeline.loginState === 'logging-in'
              ? 'Connecting…'
              : timeline.loginState === 'login-error'
                ? 'Retry login'
                : 'Connect (NIP-07)'}
          </button>
        {/if}
        <button class:active={showRelays} onclick={openRelays} title="Read relay settings">
          ⚙ Relays ({timeline.activeReadRelays.length})
        </button>
      </div>
    </div>

    <div class="acct-explain">{followExplain}</div>

    {#if timeline.loginError}
      <div class="acct-error" role="alert">Login error: {timeline.loginError}</div>
    {/if}

    {#if showRelays}
      <div class="relay-panel">
        <p class="relay-help">
          Read relays decide where notes are fetched from. Choose how your
          <strong>follow-derived</strong> list (NIP-65 kind:10002) and your
          <strong>manual</strong> list combine:
        </p>
        <div class="relay-modes">
          <label>
            <input type="radio" value="auto" bind:group={relayModeDraft} />
            <span><strong>Auto</strong> — use follow-derived relays (fallback to defaults)</span>
          </label>
          <label>
            <input type="radio" value="merge" bind:group={relayModeDraft} />
            <span><strong>Merge</strong> — follow-derived ∪ manual</span>
          </label>
          <label>
            <input type="radio" value="manual" bind:group={relayModeDraft} />
            <span><strong>Manual</strong> — manual list only (override)</span>
          </label>
        </div>

        <label class="relay-field">
          <span>Manual read relays (one wss:// URL per line)</span>
          <textarea
            class="relay-input"
            bind:value={manualRelaysDraft}
            rows="4"
            placeholder={'wss://relay.example.com\nwss://relay.damus.io'}
          ></textarea>
        </label>

        <div class="relay-lists">
          <div>
            <span class="relay-lab">Follow-derived (kind:10002):</span>
            {#if timeline.followReadRelays.length > 0}
              <ul>
                {#each timeline.followReadRelays as r (r)}<li>{r}</li>{/each}
              </ul>
            {:else}
              <span class="relay-none">none</span>
            {/if}
          </div>
          <div>
            <span class="relay-lab">Active now ({timeline.activeReadRelays.length}):</span>
            <ul>
              {#each timeline.activeReadRelays as r (r)}<li>{r}</li>{/each}
            </ul>
          </div>
        </div>

        <div class="relay-actions">
          <button class="primary" onclick={applyRelays}>Apply &amp; reconnect</button>
          <button onclick={() => (showRelays = false)}>Close</button>
        </div>
      </div>
    {/if}
  </section>

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
        <button
          onclick={onShare}
          title="Copy a link to the current view range (start/end times)"
        >
          🔗 Share
        </button>
        {#if shareNotice}
          <span class="share-notice" role="status">{shareNotice}</span>
        {/if}
      </div>

      <div class="group">
        <label class="field">
          <span>Speed</span>
          <select value={String(timeline.speed)} onchange={onSpeedChange}>
            {#each SPEED_OPTIONS as s (s)}
              <option value={String(s)}>{speedLabel(s)}</option>
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
        <label class="field">
          <span>Voice</span>
          <select
            value={timeline.selectedVoiceURI ?? ''}
            onchange={onVoiceChange}
            title="Choose a TTS voice (Auto = Japanese)"
          >
            <option value="">Auto (Japanese)</option>
            {#each timeline.availableVoices as v (v.voiceURI)}
              <option value={v.voiceURI}>{voiceLabel(v)}</option>
            {/each}
          </select>
        </label>
        <button
          class:active={timeline.ttsEnabled}
          onclick={() => timeline.toggleTts()}
          title="Read new notes aloud"
        >
          🔊 TTS {timeline.ttsEnabled ? 'on' : 'off'}
        </button>
        <button
          class:active={timeline.aiBgEnabled}
          onclick={() => timeline.toggleAiBackground()}
          title="Have on-device Gemini Nano generate a faint abstract SVG background directly from the visible timeline (no fallback; strictly validated before display)"
        >
          ✨ AI BG {timeline.aiBgEnabled ? 'on' : 'off'}
        </button>
      </div>
    </div>

    {#if timeline.aiBgEnabled}
      <div
        class="ai-status"
        class:warn={timeline.aiBgStatus === 'unsupported' ||
          timeline.aiBgStatus === 'unavailable' ||
          timeline.aiBgStatus === 'invalid-svg' ||
          timeline.aiBgStatus === 'error'}
        role="status"
      >
        {aiBgLabel}
      </div>

      <!-- Always-visible AI summary: the current summary text (or a clear
           placeholder), a state badge, and which slice it came from. Mirrors
           the same status/debug snapshot as the debug panel below. -->
      <div class="ai-summary-card" data-state={aiSummaryState} role="status">
        <div class="ai-summary-head">
          <span class="ai-summary-badge" data-tone={aiSummaryBadge.tone}>
            {aiSummaryBadge.label}
          </span>
          <span class="ai-summary-meta">{aiSummaryMeta}</span>
        </div>
        <div
          class="ai-summary-text"
          class:placeholder={aiSummaryState !== 'available'}
        >
          {#if aiSummaryState === 'available'}
            {timeline.aiBgSummary}
          {:else if aiSummaryState === 'empty'}
            {#if aiDebug.notEnoughText}
              Not enough visible note text yet — need ~{aiDebug.charsNeeded} more
              characters.
            {:else}
              Nothing distinct enough to summarize from the current view yet.
            {/if}
          {:else if aiSummaryState === 'waiting'}
            Waiting for the first summary run…
          {:else}
            {aiBgLabel}
          {/if}
        </div>
      </div>

      <details class="ai-debug">
        <summary>AI debug — Gemini Nano direct SVG: {aiDebug.directSvgUsed ? 'YES' : 'NO'}</summary>
        <div class="ai-debug-body">
          <!-- Headline verdict: did Gemini Nano generate valid SVG directly, and
               did that result actually reach the screen? No fallback path exists,
               so a NO means no background is drawn. -->
          <div class="ai-verdict" role="status">
            <span
              class="ai-badge"
              class:yes={aiDebug.directSvgUsed}
              class:no={!aiDebug.directSvgUsed}
            >
              Direct SVG: {aiDebug.directSvgUsed ? 'YES' : 'NO'}
            </span>
            <span
              class="ai-badge"
              class:yes={aiDebug.svgValid}
              class:no={!aiDebug.svgValid}
            >
              Validated: {aiDebug.svgValid ? 'YES' : 'NO'}
            </span>
            <span
              class="ai-badge"
              class:yes={aiVerdict.visible}
              class:no={!aiVerdict.visible}
            >
              On screen: {aiVerdict.visible ? 'YES' : 'NO'}
            </span>
          </div>
          {#if aiDebug.failureReason}
            <div class="ai-verdict-reasons">
              Failure: {aiDebug.failureReason}
            </div>
          {/if}
          {#if aiVerdict.reasons.length}
            <div class="ai-verdict-reasons">
              Blocked by: {aiVerdict.reasons.join('; ')}.
            </div>
          {/if}
          <div
            class="ai-debug-summary"
            class:placeholder={!timeline.aiBgSummary}
          >
            {#if timeline.aiBgSummary}
              {timeline.aiBgSummary}
            {:else if aiDebug.notEnoughText}
              Not enough text to summarize yet — need ~{aiDebug.charsNeeded} more
              characters of visible note text.
            {:else if aiHasRun}
              No summary produced yet.
            {:else}
              Waiting for the first generation run…
            {/if}
          </div>
          <!-- Live, editable view of the prompts in use. These bind directly to
               timeline state, so edits take effect (user prompt live; system
               prompt on next model start). -->
          <div class="ai-prompt-editor">
            <label>
              <span>system prompt (applies on next model start)</span>
              <textarea bind:value={timeline.aiSystemPrompt} rows="3"></textarea>
            </label>
            <label>
              <span>user prompt ({'{summary}'} is replaced with the feed text)</span>
              <textarea bind:value={timeline.aiUserPrompt} rows="3"></textarea>
            </label>
          </div>
          <dl class="ai-debug-meta">
            <div>
              <dt>Prompt API</dt>
              <dd>
                {aiDebug.promptApiSupported ? 'supported' : 'unsupported'} · {aiDebug.promptApiAvailability}{aiDebug.svgModelReady ? ' · model ready' : ''}
              </dd>
            </div>
            <div><dt>source range</dt><dd>{aiSliceLabel}</dd></div>
            <div><dt>window</dt><dd>{aiWindowLabel}</dd></div>
            <div>
              <dt>notes</dt>
              <dd>{aiDebug.summarizedCount} summarized / {aiDebug.visibleCount} visible</dd>
            </div>
            <div>
              <dt>input</dt>
              <dd>{aiDebug.inputChars} chars{aiDebug.inputTruncated ? ' (truncated)' : ''}</dd>
            </div>
            <div><dt>summary</dt><dd>{aiDebug.summaryChars} chars</dd></div>
            <div>
              <dt>raw svg</dt>
              <dd>{aiDebug.rawSvgChars} chars{aiDebug.rawSvgChars === 0 ? ' (none)' : ''}</dd>
            </div>
            <div>
              <dt>shown svg</dt>
              <dd>{aiDebug.svgChars} chars{aiDebug.svgChars === 0 ? ' (none)' : ''}</dd>
            </div>
            <div><dt>render</dt><dd>{aiRenderLabel}</dd></div>
            <div>
              <dt>in DOM</dt>
              <dd>
                {aiDebug.domCheckedAt === 0
                  ? '—'
                  : aiDebug.domInserted
                    ? `yes (${aiDebug.domSvgChars} chars)`
                    : 'no'}
              </dd>
            </div>
            <div><dt>viewBox</dt><dd>{aiDebug.viewBox || '—'}</dd></div>
            <div><dt>layer</dt><dd>{aiDomLabel}</dd></div>
            <div>
              <dt>last run</dt>
              <dd>{aiHasRun ? hms(aiDebug.lastRunAt) : '—'}</dd>
            </div>
          </dl>
        </div>
      </details>
    {/if}

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

  /* ---- account / login / relay bar ---- */
  .account-bar {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 14px;
    background: var(--bg-2);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .acct-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .acct-login {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    color: var(--text-dim);
  }
  .acct-login .acct-label {
    color: var(--text-h);
  }
  .acct-login .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-dim);
  }
  .acct-login .dot[data-login='logged-in'] {
    background: var(--ok);
    box-shadow: 0 0 6px var(--ok);
  }
  .acct-login .dot[data-login='logging-in'] {
    background: #e0b341;
  }
  .acct-login .dot[data-login='login-error'] {
    background: var(--live);
  }
  .pubkey {
    color: var(--accent);
    font-family: var(--mono);
  }
  .acct-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .acct-actions button {
    font-size: 12px;
  }
  .acct-actions button.active {
    border-color: var(--accent-border);
    color: var(--accent);
  }
  .acct-explain {
    color: var(--text-dim);
    line-height: 1.4;
  }
  .acct-error {
    color: var(--live);
    line-height: 1.4;
  }

  .relay-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 4px;
    padding: 12px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .relay-help {
    margin: 0;
    color: var(--text-dim);
    line-height: 1.5;
  }
  .relay-modes {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .relay-modes label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text);
    cursor: pointer;
  }
  .relay-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--text-dim);
  }
  .relay-input {
    resize: vertical;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    color: var(--text-h);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
  }
  .relay-input:focus {
    outline: none;
    border-color: var(--accent-border);
  }
  .relay-lists {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .relay-lists .relay-lab {
    color: var(--text-h);
    font-weight: 600;
  }
  .relay-lists ul {
    margin: 4px 0 0;
    padding-left: 16px;
    color: var(--text-dim);
    font-family: var(--mono);
    line-height: 1.5;
  }
  .relay-none {
    color: var(--text-dim);
    margin-left: 6px;
  }
  .relay-actions {
    display: flex;
    gap: 8px;
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
  .share-notice {
    font-size: 12px;
    color: var(--accent);
    white-space: nowrap;
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

  .ai-status {
    font-size: 12px;
    color: var(--text-dim);
    line-height: 1.4;
  }
  .ai-status.warn {
    color: #e0b341;
  }

  /* Always-visible AI summary card. A left accent stripe (coloured per state)
     plus a small badge make the current state legible at a glance without
     opening the debug panel. */
  .ai-summary-card {
    margin-top: 2px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--text-dim);
    background: var(--bg-3);
  }
  .ai-summary-card[data-state='available'] {
    border-left-color: var(--accent);
  }
  .ai-summary-card[data-state='failure'] {
    border-left-color: var(--live);
  }
  .ai-summary-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ai-summary-badge {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .ai-summary-badge[data-tone='ok'] {
    color: #6cc070;
    background: rgba(108, 192, 112, 0.12);
    border-color: rgba(108, 192, 112, 0.35);
  }
  .ai-summary-badge[data-tone='info'] {
    color: var(--text-dim);
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--border);
  }
  .ai-summary-badge[data-tone='warn'] {
    color: #e0b341;
    background: rgba(224, 179, 65, 0.12);
    border-color: rgba(224, 179, 65, 0.35);
  }
  .ai-summary-meta {
    font-size: 11px;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .ai-summary-text {
    font-size: 13px;
    line-height: 1.45;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 6em;
    overflow-y: auto;
  }
  .ai-summary-text.placeholder {
    color: var(--text-dim);
    font-style: italic;
  }

  /* Compact, subtle diagnostic panel for the AI background. Collapsed by
     default so it never competes with the timeline; expand to inspect. */
  .ai-debug {
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .ai-debug > summary {
    cursor: pointer;
    user-select: none;
    opacity: 0.7;
    list-style: revert;
  }
  .ai-debug > summary:hover {
    opacity: 1;
  }
  .ai-debug-body {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* Headline YES/NO badges — the at-a-glance answer. Kept small and muted so
     the panel stays a quiet diagnostic, not a billboard; colour carries the
     signal (green = YES, amber = NO) without raising the overall contrast. */
  .ai-verdict {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ai-badge {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    border: 1px solid transparent;
  }
  .ai-badge.yes {
    color: #6cc070;
    background: rgba(108, 192, 112, 0.12);
    border-color: rgba(108, 192, 112, 0.35);
  }
  .ai-badge.no {
    color: #e0b341;
    background: rgba(224, 179, 65, 0.12);
    border-color: rgba(224, 179, 65, 0.35);
  }
  .ai-verdict-reasons {
    color: var(--text-dim);
    line-height: 1.4;
  }
  .ai-debug-summary {
    max-height: 4.5em;
    overflow-y: auto;
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.04);
    line-height: 1.45;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .ai-debug-summary.placeholder {
    color: var(--text-dim);
    font-style: italic;
  }
  .ai-prompt-editor {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ai-prompt-editor label {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ai-prompt-editor span {
    opacity: 0.65;
    font-size: 0.85em;
  }
  .ai-prompt-editor textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font-family: ui-monospace, monospace;
    font-size: 0.8em;
    line-height: 1.4;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.04);
    color: var(--text);
  }
  .ai-debug-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 2px 12px;
    margin: 0;
  }
  .ai-debug-meta > div {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .ai-debug-meta dt {
    opacity: 0.65;
  }
  .ai-debug-meta dd {
    margin: 0;
    text-align: right;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  select,
  input[type='datetime-local'] {
    color-scheme: dark;
  }
</style>
