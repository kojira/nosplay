// Isolated browser smoke test for the Chrome built-in AI Prompt API.
//
// Answers ONE question: can Gemini Nano return an SVG string from a short text
// prompt? It calls the REAL on-device API (no mocks) and surfaces two raw
// observation points: the model's untrusted output (promptSvg) and the strict
// validator's verdict (validateAndSanitizeSvg). This page is product-logic-free
// on purpose; it only reuses the existing ai/* helpers.
//
// Browser-only: the Prompt API (`LanguageModel`, Gemini Nano) exists only in a
// Chrome build with built-in AI enabled. It cannot run in Node/CI — building
// this file only proves it compiles, not that generation works.

import {
  isLanguageModelSupported,
  languageModelAvailability,
  createSvgModel,
  promptSvg,
} from './lib/ai/prompt';
import { inspectSvg, type SvgInspection } from './lib/ai/sanitize';

const promptInput = document.querySelector<HTMLInputElement>('#prompt')!;
const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const rawEl = document.querySelector<HTMLPreElement>('#raw')!;
const validationEl = document.querySelector<HTMLDivElement>('#validation')!;
const inspectionEl = document.querySelector<HTMLPreElement>('#inspection')!;
const svgContainer = document.querySelector<HTMLDivElement>('#svgContainer')!;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

/** Render the full inspection evidence as plain text, pass or fail. */
function formatInspection(r: SvgInspection): string {
  const lines = [
    `verdict: ${r.ok ? 'VALID' : 'INVALID'}`,
    `stage: ${r.stage ?? 'passed'}`,
    `reason: ${r.reason || '(none)'}`,
    `raw length: ${r.rawLength}`,
    `extracted <svg> length: ${r.extractedLength}`,
    `prefix noise: ${r.hasPrefixNoise ? `yes — ${JSON.stringify(r.prefixText)}` : 'no'}`,
    `suffix noise: ${r.hasSuffixNoise ? `yes — ${JSON.stringify(r.suffixText)}` : 'no'}`,
  ];
  if (r.element) lines.push(`element: <${r.element}>`);
  if (r.attribute) lines.push(`attribute: ${r.attribute}`);
  if (r.value) lines.push(`value: ${JSON.stringify(r.value)}`);
  return lines.join('\n');
}

async function run(): Promise<void> {
  // Reset prior output so a re-run never shows stale results.
  rawEl.textContent = '';
  validationEl.textContent = '';
  inspectionEl.textContent = '';
  validationEl.className = '';
  svgContainer.innerHTML = '';
  runButton.disabled = true;

  try {
    const supported = isLanguageModelSupported();
    const availability = await languageModelAvailability();
    setStatus(
      `isLanguageModelSupported: ${supported} · availability: ${availability}`,
    );

    if (!supported || availability === 'unavailable') {
      setStatus(
        `Prompt API not usable here (supported: ${supported}, availability: ` +
          `${availability}). This is browser-only — it needs Chrome with the ` +
          'built-in AI Prompt API / Gemini Nano enabled. Stopping.',
      );
      return;
    }

    setStatus(
      `Supported, availability: ${availability}. Creating model session…`,
    );
    const model = await createSvgModel((fraction: number) => {
      setStatus(
        `Downloading on-device model… ${Math.round(fraction * 100)}%`,
      );
    });

    try {
      setStatus('Model ready. Prompting Gemini Nano for SVG…');
      const raw = await promptSvg(model, promptInput.value);

      // Observation point #1: the RAW, untrusted model output, verbatim.
      rawEl.textContent = raw;
      setStatus(`Got raw output (${raw.length} chars). Inspecting…`);

      // Observation point #2: the strict validator's DETAILED verdict. Always
      // surface the full evidence (raw vs extracted length, prefix/suffix noise,
      // exact failure stage/reason) so a pass and a fail are equally diagnosable.
      const result = inspectSvg(raw);
      inspectionEl.textContent = formatInspection(result);
      if (result.ok) {
        validationEl.textContent = 'VALID';
        validationEl.className = 'valid';
        // Sanitizer already re-serialised from a fully-checked tree, so the
        // markup is safe to inject for visual confirmation.
        svgContainer.innerHTML = result.svg;
        setStatus('Done: model returned SVG that passed validation.');
      } else {
        validationEl.textContent = `INVALID [${result.stage}]: ${result.reason}`;
        validationEl.className = 'invalid';
        setStatus('Done: model output failed strict SVG validation.');
      }
    } finally {
      model.destroy();
    }
  } catch (err) {
    // Never fabricate output — just report the real failure.
    setStatus(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener('click', () => {
  void run();
});
