// メインスレッド: 音声キャプチャ → 無音区切りでセグメント化 → Worker(Whisper)へ
const SAMPLE_RATE = 16000;
const SILENCE_RMS = 0.005;      // これ以下のRMSは無音とみなす
const SILENCE_FLUSH_S = 0.7;    // 無音がこの秒数続いたらセグメント確定
const MAX_SEGMENT_S = 15;       // セグメント最大長
const MIN_SEGMENT_S = 0.4;      // これより短い音声は捨てる
const PREROLL_CHUNKS = 4;       // 発話開始前に遡って含めるチャンク数(~0.5秒)
const INTERIM_INTERVAL_MS = 2500; // 発話中の暫定認識の間隔
const INTERIM_MIN_S = 1.2;      // 暫定認識にかける最小の音声長

const el = (id) => document.getElementById(id);

let worker = null;
let workerReady = false;
let loadedModel = null;
let audioCtx = null;
let running = false;
let streams = [];
let segmenters = [];
let sessionStart = 0;
let nextId = 1;
const pending = new Map();   // id -> { source, start, interim }
const results = [];          // { start, source, text }
let queueCount = 0;
let deviceType = '';
let interimTimer = null;
const interimShown = new Map();    // source -> { source, start, text }
const interimInflight = new Map(); // source -> id

// ---- 無音検出でセグメントを切り出す ----
class Segmenter {
  constructor(source, onSegment) {
    this.source = source;
    this.onSegment = onSegment;
    this.preroll = [];
    this.chunks = null;
    this.segmentStart = 0;
    this.silence = 0;
    this.time = 0;
  }
  push(f32) {
    const dur = f32.length / SAMPLE_RATE;
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const speaking = Math.sqrt(sum / f32.length) > SILENCE_RMS;

    if (this.chunks) {
      this.chunks.push(f32);
      this.silence = speaking ? 0 : this.silence + dur;
      const segDur = this.time + dur - this.segmentStart;
      if (this.silence >= SILENCE_FLUSH_S || segDur >= MAX_SEGMENT_S) this.flush();
    } else if (speaking) {
      this.chunks = [...this.preroll, f32];
      const prerollDur = this.preroll.reduce((a, c) => a + c.length, 0) / SAMPLE_RATE;
      this.segmentStart = this.time - prerollDur;
      this.silence = 0;
      this.preroll = [];
    } else {
      this.preroll.push(f32);
      if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift();
    }
    this.time += dur;
  }
  // 発話中のセグメントの現時点までのコピーを返す(暫定認識用)
  snapshot() {
    if (!this.chunks) return null;
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    if (total / SAMPLE_RATE < INTERIM_MIN_S) return null;
    const audio = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) { audio.set(c, offset); offset += c.length; }
    return { audio, start: this.segmentStart };
  }
  flush() {
    if (!this.chunks) return;
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    const audio = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) { audio.set(c, offset); offset += c.length; }
    const speechDur = total / SAMPLE_RATE - this.silence;
    const start = this.segmentStart;
    this.chunks = null;
    this.silence = 0;
    if (speechDur >= MIN_SEGMENT_S) this.onSegment({ source: this.source, audio, start });
  }
}

// ---- Worker ----
function ensureWorker() {
  if (worker) return;
  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      workerReady = true;
      loadedModel = el('model').value;
      deviceType = msg.device;
      if (running) updateRunningStatus();
    } else if (msg.type === 'result') {
      onResult(msg);
    } else if (msg.type === 'error') {
      setStatus('エラー: ' + msg.message);
      el('btnStart').disabled = false;
    }
  };
  worker.onerror = (e) => {
    setStatus('Workerエラー: ' + e.message);
    el('btnStart').disabled = false;
  };
}

function loadModel() {
  ensureWorker();
  const model = el('model').value;
  if (workerReady && loadedModel === model) return;
  workerReady = false;
  worker.postMessage({ type: 'load', model });
}

// ---- 日本語への翻訳 (Chrome内蔵 Translator API / LanguageDetector API) ----
const canTranslate = 'Translator' in self && 'LanguageDetector' in self;
const translators = new Map(); // sourceLang -> Promise<Translator|null>
let detectorPromise = null;

function setTransStatus(msg) { el('transStatus').textContent = msg; }

function reportTranslateIssue(src, err) {
  console.warn(`translate ${src}→ja:`, err);
  if (err?.name === 'NotAllowedError') {
    setTransStatus('翻訳: 言語パックの準備にはクリック操作が必要です。「日本語に翻訳」を一度OFF→ONしてください');
  } else {
    setTransStatus(`翻訳を利用できません(${src}→日本語): ${err?.message || err} ※文字起こしは継続します`);
  }
}

function getTranslator(src) {
  let p = translators.get(src);
  if (!p) {
    p = (async () => {
      const avail = await Translator.availability({ sourceLanguage: src, targetLanguage: 'ja' });
      if (avail === 'unavailable') {
        setTransStatus(`翻訳: ${src}→日本語 はこの環境では利用できません`);
        return null;
      }
      if (avail !== 'available') setTransStatus(`翻訳: 言語パック(${src}→日本語)を準備中…`);
      const tr = await Translator.create({
        sourceLanguage: src,
        targetLanguage: 'ja',
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            setTransStatus(`翻訳: 言語パック(${src}→日本語)をダウンロード中… ${Math.round((e.loaded || 0) * 100)}%`);
          });
        },
      });
      setTransStatus(`翻訳: ${src}→日本語 準備完了`);
      return tr;
    })().catch((err) => {
      translators.delete(src); // 失敗はキャッシュせず次回再試行
      reportTranslateIssue(src, err);
      return null;
    });
    translators.set(src, p);
  }
  return p;
}

// 長文を一度に渡すとChrome内蔵翻訳が後半を省略することがあるため、
// 句読点で分割して順に翻訳する。Whisperの中国語出力のように句読点が
// 無い場合は、読点・スペース・固定長で強制的に区切る
function isMostlyCjk(text) {
  return (text.match(/[　-鿿＀-￯]/g) || []).length > text.length / 2;
}

function splitForTranslation(text) {
  const maxLen = isMostlyCjk(text) ? 30 : 150;
  if (text.length <= maxLen) return [text];
  const parts = text.split(/(?<=[。．.!?！?;;])/);
  const chunks = [];
  let cur = '';
  const push = () => { if (cur.trim()) chunks.push(cur); cur = ''; };
  for (const p of parts) {
    if (cur && (cur + p).length > maxLen) push();
    cur += p;
    while (cur.length > maxLen) {
      let cut = -1;
      for (const d of ['、', ',', ',', ' ']) cut = Math.max(cut, cur.lastIndexOf(d, maxLen));
      cut = cut >= maxLen * 0.4 ? cut + 1 : maxLen; // 区切りが手前すぎるときは固定長で切る
      chunks.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
  }
  push();
  return chunks;
}

// 1チャンクを翻訳し、訳が入力より明らかに短い場合(CJK→日本語は通常
// 同等以上の長さになるため、省略の疑いが強い)は半分に割って訳し直す
async function translateChunk(translator, piece, depth = 0) {
  const ja = (await withTimeout(translator.translate(piece), 15000)).trim();
  if (isMostlyCjk(piece) && depth < 2 && piece.length >= 16 && ja.length < piece.length * 0.7) {
    const mid = Math.ceil(piece.length / 2);
    const a = await translateChunk(translator, piece.slice(0, mid), depth + 1);
    const b = await translateChunk(translator, piece.slice(mid), depth + 1);
    return a + b;
  }
  return ja;
}

// quick=true(暫定表示用)は分割せず1回で翻訳する(負荷を抑える。確定時に完全な訳に置き換わる)
async function translateToJa(text, quick = false) {
  if (!canTranslate) return null;
  try {
    // 言語が明示指定されていればそれを翻訳元に使い、自動判定のときだけ言語検出する
    let src = el('language').value;
    if (!src || src === 'ja') {
      if (!detectorPromise) detectorPromise = LanguageDetector.create();
      const detector = await detectorPromise;
      if (!detector) return null;
      const [top] = await detector.detect(text);
      src = top?.detectedLanguage;
    }
    if (!src || src === 'ja' || src === 'und') return null;
    src = translatorLangCode(src);
    const translator = await getTranslator(src);
    if (!translator) return null;
    const pieces = quick ? [text] : splitForTranslation(text);
    const out = [];
    try {
      for (const piece of pieces) {
        const ja = quick
          ? (await withTimeout(translator.translate(piece), 15000)).trim()
          : await translateChunk(translator, piece);
        if (ja) out.push(ja);
      }
    } catch (err) {
      // 翻訳器が途中でクラッシュ/ハングすることがあるため、
      // 壊れたインスタンスは破棄して次回の呼び出しで作り直す
      translators.delete(src);
      reportTranslateIssue(src, err);
      return null;
    }
    const joined = out.join(''); // 訳文は日本語なので区切りなしで結合してよい
    return joined && joined !== text ? joined : null;
  } catch (err) {
    detectorPromise = null; // 言語検出の失敗は次回作り直す
    reportTranslateIssue('auto', err);
    return null;
  }
}

// Chrome翻訳APIは中国語をスクリプト(簡体字/繁体字)まで区別するが、
// Whisperの言語コードはスクリプトを区別しない 'zh' なので、既定で簡体字に読み替える
function translatorLangCode(code) {
  return code === 'zh' ? 'zh-Hans' : code;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

// 言語パックのダウンロードにはユーザー操作(クリック)起点が必要な場合があるため、
// ボタン操作のタイミングで想定ペアを事前準備する
function warmupTranslators() {
  if (!canTranslate || !el('optTranslate').checked) return;
  if (!detectorPromise) {
    detectorPromise = LanguageDetector.create().catch((err) => {
      detectorPromise = null;
      reportTranslateIssue('言語検出', err);
      return null;
    });
  }
  // 使う見込みの高い言語だけ準備する。複数の言語パックを同時にロードすると
  // メモリ圧迫で既存の翻訳器がクラッシュすることがあるため、無条件の追加はしない
  const langs = new Set(['en']);
  const sel = el('language').value;
  if (sel && sel !== 'ja') langs.add(translatorLangCode(sel));
  for (const src of langs) getTranslator(src);
}

// ---- 文字起こし結果 ----
function onResult({ id, text, error }) {
  const meta = pending.get(id);
  pending.delete(id);
  if (error) console.warn('transcribe error:', error);
  if (!meta) return;

  // 暫定結果: 同じセグメントの確定結果がまだ無ければグレー表示を更新
  if (meta.interim) {
    interimInflight.delete(meta.source);
    const finalized = results.some((r) => r.source === meta.source && r.start === meta.start);
    if (text && !finalized) {
      const prev = interimShown.get(meta.source);
      const entry = { source: meta.source, start: meta.start, text, translation: null };
      // 同じセグメントの直前の暫定訳は引き継ぐ(新しい訳が来るまでのちらつき防止)
      if (prev && prev.start === meta.start) entry.translation = prev.translation;
      interimShown.set(meta.source, entry);
      renderTranscript();
      if (el('optTranslate').checked) {
        translateToJa(text, true).then((ja) => {
          // 確定・更新で置き換わっていた場合は適用しない
          if (ja && interimShown.get(meta.source) === entry) {
            entry.translation = ja;
            renderTranscript();
          }
        });
      }
    }
    return;
  }

  // 確定結果: 対応する暫定表示を置き換える
  queueCount = Math.max(0, queueCount - 1);
  updateRunningStatus();
  if (interimShown.get(meta.source)?.start === meta.start) {
    interimShown.delete(meta.source);
    renderTranscript();
  }
  if (!text) return;
  const entry = { start: meta.start, source: meta.source, text, translation: null };
  results.push(entry);
  results.sort((a, b) => a.start - b.start);
  renderTranscript();
  el('btnDownload').disabled = false;
  el('btnClear').disabled = false;
  if (el('optTranslate').checked) {
    translateToJa(text).then((ja) => {
      if (ja && results.includes(entry)) {
        entry.translation = ja;
        renderTranscript();
      }
    });
  }
}

function clearTranscript() {
  if (results.length === 0) return;
  if (!confirm('文字起こし結果をすべて消去します。よろしいですか?(保存していないテキストは失われます)')) return;
  results.length = 0;
  pending.clear(); // 認識中のセグメントもクリア後は表示しない
  interimShown.clear();
  interimInflight.clear();
  el('transcript').innerHTML = '<div class="empty">ここに文字起こし結果が表示されます</div>';
  el('btnDownload').disabled = true;
  el('btnClear').disabled = true;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function renderTranscript() {
  const box = el('transcript');
  box.innerHTML = '';
  const items = [
    ...results,
    ...[...interimShown.values()].map((v) => ({ ...v, interim: true })),
  ].sort((a, b) => a.start - b.start);
  for (const r of items) {
    const row = document.createElement('div');
    row.className = r.interim ? 'row interim' : 'row';
    const isMe = r.source === 'mic';
    row.innerHTML = `<span class="time">[${fmtTime(r.start)}]</span>` +
      `<span class="spk ${isMe ? 'me' : 'them'}">${isMe ? '自分' : '相手'}</span>` +
      `<span></span>`;
    const body = row.lastElementChild;
    body.textContent = r.text;
    if (r.translation) {
      const t = document.createElement('div');
      t.className = 'trans';
      t.textContent = r.translation;
      body.appendChild(t);
    }
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

function onSegment({ source, audio, start }) {
  // モデル読み込み中でもWorker側のキューが load → transcribe の順で
  // 直列処理するため、そのまま送って取りこぼしを防ぐ
  const id = nextId++;
  pending.set(id, { source, start });
  queueCount++;
  updateRunningStatus();
  worker.postMessage({ type: 'transcribe', id, audio, language: el('language').value }, [audio.buffer]);
}

// 訳が付かなかった確定行を定期的に再翻訳する(翻訳器クラッシュ後の回復用)。
// 1行につき最大3回まで試す(日本語発話など訳が不要な行を無限に再試行しない)
const RETRY_TRANSLATE_MS = 20000;
let retryBusy = false;
async function retryMissingTranslations() {
  if (retryBusy || !canTranslate || !el('optTranslate').checked) return;
  retryBusy = true;
  try {
    const missing = results.filter((r) => !r.translation && (r.translationTried || 0) < 3).slice(-5);
    for (const entry of missing) {
      entry.translationTried = (entry.translationTried || 0) + 1;
      const ja = await translateToJa(entry.text);
      if (ja && results.includes(entry)) {
        entry.translation = ja;
        renderTranscript();
      }
    }
  } finally {
    retryBusy = false;
  }
}
setInterval(retryMissingTranslations, RETRY_TRANSLATE_MS);

// 発話中のセグメントを定期的に途中まで認識して暫定表示する
// (WASMは推論が遅く確定認識を圧迫するためWebGPU時のみ)
function interimTick() {
  if (!running || !workerReady || deviceType !== 'WebGPU') return;
  for (const seg of segmenters) {
    if (interimInflight.has(seg.source)) continue;
    const snap = seg.snapshot();
    if (!snap) continue;
    const id = nextId++;
    pending.set(id, { source: seg.source, start: snap.start, interim: true });
    interimInflight.set(seg.source, id);
    worker.postMessage({ type: 'transcribe', id, audio: snap.audio, language: el('language').value }, [snap.audio.buffer]);
  }
}

function setStatus(msg) { el('status').textContent = msg; }
function updateRunningStatus() {
  if (running) setStatus(`文字起こし中… ${queueCount > 0 ? `(認識キュー: ${queueCount})` : ''}`);
}

// ---- キャプチャ開始/停止 ----
async function start() {
  const useTab = el('srcTab').checked;
  const useMic = el('srcMic').checked;
  if (!useTab && !useMic) { setStatus('音声ソースを1つ以上選択してください。'); return; }

  el('btnStart').disabled = true;
  loadModel();
  warmupTranslators(); // クリック起点で翻訳言語パックを準備

  try {
    streams = [];
    const sources = []; // { track, source }
    if (useTab) {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      streams.push(display);
      const audioTracks = display.getAudioTracks();
      if (audioTracks.length === 0) {
        display.getTracks().forEach((t) => t.stop());
        setStatus('音声トラックが取得できませんでした。共有ダイアログで「タブ」を選び、「タブの音声も共有する」にチェックしてください。');
        el('btnStart').disabled = false;
        return;
      }
      sources.push({ track: audioTracks[0], source: 'tab' });
      // ユーザーがブラウザUIから共有停止した場合
      display.getVideoTracks()[0]?.addEventListener('ended', stop);
    }
    if (useMic) {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streams.push(mic);
      sources.push({ track: mic.getAudioTracks()[0], source: 'mic' });
    }

    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await audioCtx.audioWorklet.addModule('pcm-processor.js');
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    mute.connect(audioCtx.destination);

    segmenters = [];
    for (const { track, source } of sources) {
      const seg = new Segmenter(source, onSegment);
      segmenters.push(seg);
      const node = new AudioWorkletNode(audioCtx, 'pcm-processor');
      const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
      src.connect(node);
      node.connect(mute); // 音は出さずにグラフを駆動
      node.port.onmessage = (e) => seg.push(new Float32Array(e.data));
    }

    running = true;
    sessionStart = Date.now();
    interimTimer = setInterval(interimTick, INTERIM_INTERVAL_MS);
    el('btnStart').style.display = 'none';
    el('btnStop').style.display = 'inline-block';
    updateRunningStatus();
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      setStatus('キャプチャがキャンセルされました。');
    } else {
      setStatus('開始に失敗しました: ' + err.message);
    }
    stopStreams();
    el('btnStart').disabled = false;
  }
}

function stopStreams() {
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}

function stop() {
  if (!running) return;
  running = false;
  clearInterval(interimTimer);
  interimTimer = null;
  segmenters.forEach((s) => s.flush());
  segmenters = [];
  stopStreams();
  el('btnStart').style.display = '';
  el('btnStart').disabled = false;
  el('btnStop').style.display = 'none';
  setStatus(queueCount > 0 ? `停止しました(残り ${queueCount} 件を認識中…)` : '停止しました。');
}

// ---- 保存 ----
function download() {
  const lines = results.map((r) =>
    `[${fmtTime(r.start)}] ${r.source === 'mic' ? '自分' : '相手'}: ${r.text}` +
    (r.translation ? `\n    (訳) ${r.translation}` : ''));
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `transcript_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- 初期化 ----
el('btnStart').addEventListener('click', start);
el('btnStop').addEventListener('click', stop);
el('btnDownload').addEventListener('click', download);
el('btnClear').addEventListener('click', clearTranscript);
el('optTranslate').addEventListener('change', warmupTranslators);

if (!canTranslate) {
  el('optTranslate').checked = false;
  el('optTranslate').disabled = true;
  el('optTranslate').parentElement.title = '日本語への翻訳は Chrome 138 以降(内蔵翻訳AI対応)で利用できます';
}

if (!navigator.mediaDevices?.getDisplayMedia) {
  el('warnBrowser').style.display = 'block';
  el('btnStart').disabled = true;
}
if (!navigator.gpu) {
  setStatus('注意: このブラウザはWebGPU非対応のためWASM(低速)で動作します。');
}
