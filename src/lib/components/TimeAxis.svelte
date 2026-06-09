<script lang="ts">
  import { timeline } from '../timeline/store.svelte';
  import { hms } from '../timeline/format';

  const TICKS = 6; // number of interior tick marks across the window

  interface Tick {
    f: number; // 0..1 from right edge
    label: string;
  }

  const ticks = $derived.by<Tick[]>(() => {
    const playhead = timeline.playheadMs;
    const win = timeline.windowMs;
    const out: Tick[] = [];
    for (let i = 1; i <= TICKS; i++) {
      const f = i / (TICKS + 1);
      const ms = playhead - f * win;
      out.push({ f, label: hms(ms) });
    }
    return out;
  });
</script>

<div class="axis" aria-hidden="false" aria-label="Time axis">
  {#each ticks as t (t.f)}
    <div class="tick" style="right: {t.f * 100}%;">
      <span class="mark"></span>
      <span class="label">{t.label}</span>
    </div>
  {/each}

  <div class="tick right">
    <span class="mark live-mark"></span>
    <span class="label edge">
      {#if timeline.isLive}LIVE{:else}{hms(timeline.playheadMs)}{/if}
    </span>
  </div>
</div>

<style>
  .axis {
    position: relative;
    height: 34px;
    background: var(--bg-2);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }

  .tick {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    transform: translateX(50%);
  }

  .tick.right {
    right: 0;
    transform: none;
    align-items: flex-end;
    padding-right: 4px;
  }

  .mark {
    width: 1px;
    height: 8px;
    background: var(--border);
  }

  .live-mark {
    width: 2px;
    background: var(--live);
  }

  .label {
    margin-top: 2px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
  }

  .label.edge {
    color: var(--live);
    font-weight: 700;
  }
</style>
