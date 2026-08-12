// Sugestões automáticas para a tela de tagging da galeria: onde estão as
// falas (por energia do áudio) e um palpite de "quem é quem" (por tom de
// voz). Tudo roda no navegador, sem serviço externo — são só sugestões,
// o jogador sempre revisa/corrige antes de salvar o clipe.

const WINDOW_SEC = 0.05;
const MERGE_GAP_SEC = 0.35;
const MIN_SEGMENT_SEC = 0.3;
const MAX_SEGMENT_SEC = 6;
const SPLIT_SEARCH_RADIUS_SEC = 1.2;
const ABSOLUTE_MIN_THRESHOLD = 0.012;
const THRESHOLD_FLOOR_PERCENTILE = 0.35;
const THRESHOLD_PEAK_PERCENTILE = 0.92;
const THRESHOLD_MARGIN = 0.3;
// Uma vez que uma fala começou (passou do limiar acima), ela continua
// enquanto o volume ficar só acima deste limiar mais baixo — evita que uma
// queda momentânea de volume no meio de uma frase corte a fala em duas.
const CONTINUE_THRESHOLD_RATIO = 0.55;

const PITCH_MIN_HZ = 80;
const PITCH_MAX_HZ = 400;
const PITCH_FRAME_SIZE = 2048;
const PITCH_FRAME_STRIDE = 2; // analisa 1 a cada N janelas pra reduzir custo
const PITCH_VOICED_RMS = 0.02;
// Decima o frame antes da autocorrelação: só precisamos resolver até
// PITCH_MAX_HZ, então analisar em ~11kHz em vez de 44.1kHz custa ~16x menos
// (frame e faixa de lag menores) sem perder precisão útil.
const PITCH_DECIMATION = 4;
// Correlação normalizada mínima (0-1) pra aceitar um lag como pitch real —
// descarta frames ruidosos/não-periódicos que antes "acertavam" um lag
// qualquer por acaso.
const PITCH_MIN_CONFIDENCE = 0.35;
// Autocorrelação tende a também dar um pico forte em submúltiplos do lag
// verdadeiro (erro de oitava). Preferimos o menor lag cuja correlação
// chegue perto do melhor score, em vez de sempre pegar o score máximo.
const OCTAVE_BIAS_RATIO = 0.85;
const CLUSTER_DISTANCE_HZ = 28;
const CHARACTER_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export async function decodeVideoAudio(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  try {
    return await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    audioCtx.close();
  }
}

export function toMono(audioBuffer) {
  if (audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i] / audioBuffer.numberOfChannels;
  }
  return mono;
}

function rms(samples, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (end - start));
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
  return sortedArr[idx];
}

// Cede o controle pro navegador (deixa pintar a tela / responder a input)
// entre blocos de trabalho pesado. Prefere requestAnimationFrame (rápido,
// ~16ms, quando a aba está visível); um setTimeout de segurança garante
// que a análise não trave de vez se a aba ficar em segundo plano.
function yieldToUI() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    setTimeout(finish, 100);
  });
}

/**
 * Corta um trecho longo demais (ex: cena inteira sem silêncio real, comum
 * quando há música de fundo) em pedaços jogáveis, cortando sempre no ponto
 * mais "quieto" perto do alvo em vez de num tempo fixo arbitrário.
 */
function splitLongRun(run, windowRms, windowSize, sampleRate, maxDuration) {
  if (run.end - run.start <= maxDuration) return [run];

  const runStartIdx = Math.floor((run.start * sampleRate) / windowSize);
  const runEndIdx = Math.min(windowRms.length - 1, Math.ceil((run.end * sampleRate) / windowSize));

  const pieces = [];
  let segStart = run.start;
  while (run.end - segStart > maxDuration) {
    const targetTime = segStart + maxDuration;
    const searchStartIdx = Math.max(
      runStartIdx,
      Math.floor(((targetTime - SPLIT_SEARCH_RADIUS_SEC) * sampleRate) / windowSize)
    );
    const searchEndIdx = Math.min(
      runEndIdx,
      Math.ceil(((targetTime + SPLIT_SEARCH_RADIUS_SEC) * sampleRate) / windowSize)
    );

    let cutIdx = Math.round((targetTime * sampleRate) / windowSize);
    let cutVal = Infinity;
    for (let i = searchStartIdx; i <= searchEndIdx; i++) {
      if (windowRms[i] < cutVal) {
        cutVal = windowRms[i];
        cutIdx = i;
      }
    }
    const cutTime = Math.max(segStart + 0.5, (cutIdx * windowSize) / sampleRate);
    pieces.push({ start: segStart, end: cutTime });
    segStart = cutTime;
  }
  pieces.push({ start: segStart, end: run.end });
  return pieces;
}

/**
 * Detecta trechos com fala/som por energia do áudio (RMS por janela +
 * fusão de pequenas pausas), sem depender de reconhecimento de voz. O
 * limiar se adapta ao volume do próprio clipe (clipes com trilha sonora de
 * fundo têm um piso de ruído mais alto que um clipe silencioso), e trechos
 * longos demais (sem silêncio real, ex: cena com música contínua) são
 * cortados em pedaços de até `maxDuration` no ponto mais quieto encontrado.
 * @returns {Array<{start:number end:number}>} tempos em segundos
 */
export function detectSpeechSegments(audioBuffer, opts = {}) {
  const mergeGap = opts.mergeGap ?? MERGE_GAP_SEC;
  const minDuration = opts.minDuration ?? MIN_SEGMENT_SEC;
  const maxDuration = opts.maxDuration ?? MAX_SEGMENT_SEC;

  const samples = toMono(audioBuffer);
  const sampleRate = audioBuffer.sampleRate;
  const windowSize = Math.round(WINDOW_SEC * sampleRate);

  const windowRms = [];
  for (let start = 0; start < samples.length; start += windowSize) {
    const end = Math.min(start + windowSize, samples.length);
    windowRms.push(rms(samples, start, end));
  }

  let threshold = opts.threshold;
  if (threshold == null) {
    const sorted = [...windowRms].sort((a, b) => a - b);
    const floor = percentile(sorted, THRESHOLD_FLOOR_PERCENTILE);
    const peak = percentile(sorted, THRESHOLD_PEAK_PERCENTILE);
    threshold = Math.max(ABSOLUTE_MIN_THRESHOLD, floor + (peak - floor) * THRESHOLD_MARGIN);
  }

  const continueThreshold = threshold * CONTINUE_THRESHOLD_RATIO;

  const runs = [];
  let active = null;
  windowRms.forEach((value, i) => {
    const t = (i * windowSize) / sampleRate;
    const tEnd = Math.min(((i + 1) * windowSize) / sampleRate, audioBuffer.duration);
    const keepsGoing = value > threshold || (active && value > continueThreshold);
    if (keepsGoing) {
      if (!active) active = { start: t, end: tEnd };
      else active.end = tEnd;
    } else if (active) {
      runs.push(active);
      active = null;
    }
  });
  if (active) runs.push(active);

  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run.start - last.end <= mergeGap) {
      last.end = run.end;
    } else {
      merged.push({ ...run });
    }
  }

  const capped = merged.flatMap((run) => splitLongRun(run, windowRms, windowSize, sampleRate, maxDuration));

  return capped
    .filter((seg) => seg.end - seg.start >= minDuration)
    .map((seg, i) => ({ id: `seg-${i}`, start: seg.start, end: seg.end }));
}

// Filtro de média móvel de 2 amostras + subamostragem: reduz aliasing antes
// de decimar (barato, O(n)) já que só nos importa conteúdo até PITCH_MAX_HZ.
function decimate(frame, factor) {
  const outLen = Math.floor(frame.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) sum += frame[base + k];
    out[i] = sum / factor;
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Estimativa de pitch por autocorrelação normalizada num frame de áudio
// (decimado antes, pra baratear). Retorna a frequência fundamental em Hz, ou
// null se o frame parece sem voz/silencioso/não-periódico o bastante.
function estimatePitch(frame, sampleRate) {
  if (rms(frame, 0, frame.length) < PITCH_VOICED_RMS) return null;

  const decimated = decimate(frame, PITCH_DECIMATION);
  const effectiveSampleRate = sampleRate / PITCH_DECIMATION;
  const minLag = Math.max(1, Math.floor(effectiveSampleRate / PITCH_MAX_HZ));
  const maxLag = Math.min(decimated.length - 2, Math.floor(effectiveSampleRate / PITCH_MIN_HZ));
  if (maxLag <= minLag) return null;

  let energy0 = 0;
  for (let i = 0; i < decimated.length; i++) energy0 += decimated[i] * decimated[i];
  if (energy0 <= 0) return null;

  const scores = new Float32Array(maxLag + 1);
  let bestLag = -1;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    for (let i = 0; i < decimated.length - lag; i++) {
      correlation += decimated[i] * decimated[i + lag];
    }
    const score = correlation / energy0;
    scores[lag] = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestScore < PITCH_MIN_CONFIDENCE) return null;

  // Corrige erro de oitava: prefere o menor lag "quase tão bom" quanto o
  // melhor, em vez do pico absoluto (que costuma cair num submúltiplo).
  for (let lag = minLag; lag < bestLag; lag++) {
    if (scores[lag] >= bestScore * OCTAVE_BIAS_RATIO) {
      bestLag = lag;
      break;
    }
  }

  // Interpolação parabólica ao redor do lag escolhido pra suavizar o passo
  // de quantização introduzido pela decimação.
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const c0 = scores[bestLag - 1];
    const c1 = scores[bestLag];
    const c2 = scores[bestLag + 1];
    const denom = c0 - 2 * c1 + c2;
    if (denom !== 0) {
      const delta = (0.5 * (c0 - c2)) / denom;
      if (delta > -1 && delta < 1) refinedLag = bestLag + delta;
    }
  }

  return effectiveSampleRate / refinedLag;
}

function averageSegmentPitch(samples, sampleRate, startSec, endSec) {
  const start = Math.floor(startSec * sampleRate);
  const end = Math.min(Math.floor(endSec * sampleRate), samples.length);
  const step = PITCH_FRAME_SIZE * PITCH_FRAME_STRIDE;
  const pitches = [];
  for (let pos = start; pos + PITCH_FRAME_SIZE <= end; pos += step) {
    const frame = samples.subarray(pos, pos + PITCH_FRAME_SIZE);
    const pitch = estimatePitch(frame, sampleRate);
    if (pitch) pitches.push(pitch);
  }
  if (!pitches.length) return null;
  // Mediana em vez de média: um único frame com erro de oitava não puxa a
  // estimativa do segmento inteiro pra longe do valor real.
  return median(pitches);
}

/**
 * Agrupa segmentos por semelhança de tom de voz e sugere um rótulo de
 * personagem para cada um. Heurístico simples e barato — é só um palpite
 * inicial, o jogador renomeia/reagrupa livremente na tela de tagging.
 * Assíncrona e cede o thread entre segmentos pra não travar a aba em
 * clipes mais longos.
 * @returns {Promise<Map<string,string>>} segmentId -> "Personagem A" | "Personagem B" | ...
 */
export async function estimateCharacterClusters(audioBuffer, segments) {
  const samples = toMono(audioBuffer);
  const sampleRate = audioBuffer.sampleRate;

  // Cede o thread só de vez em quando (não a cada segmento) — chamar
  // setTimeout com frequência demais é caro por si só, especialmente se a
  // aba estiver em segundo plano e o navegador atrasar o timer.
  const withPitch = [];
  let lastYield = performance.now();
  for (const seg of segments) {
    withPitch.push({ id: seg.id, pitch: averageSegmentPitch(samples, sampleRate, seg.start, seg.end) });
    if (performance.now() - lastYield > 80) {
      await yieldToUI();
      lastYield = performance.now();
    }
  }

  const clusters = []; // { mean, count }
  const guesses = new Map();

  withPitch.forEach(({ id, pitch }) => {
    if (pitch == null) {
      guesses.set(id, null);
      return;
    }
    let closest = null;
    let closestDist = Infinity;
    clusters.forEach((cluster) => {
      const dist = Math.abs(cluster.mean - pitch);
      if (dist < closestDist) {
        closestDist = dist;
        closest = cluster;
      }
    });

    let cluster = closest && closestDist <= CLUSTER_DISTANCE_HZ ? closest : null;
    if (!cluster) {
      cluster = { mean: pitch, count: 0, index: clusters.length };
      clusters.push(cluster);
    }
    cluster.mean = (cluster.mean * cluster.count + pitch) / (cluster.count + 1);
    cluster.count += 1;
    guesses.set(id, `Personagem ${CHARACTER_LABELS[cluster.index] || cluster.index + 1}`);
  });

  // Segmentos sem pitch detectável (ex: ruído) caem no primeiro personagem
  // encontrado, se existir, só pra não deixar o campo vazio na UI.
  const fallback = clusters.length ? `Personagem ${CHARACTER_LABELS[0]}` : 'Personagem A';
  guesses.forEach((value, id) => {
    if (value == null) guesses.set(id, fallback);
  });

  return guesses;
}
