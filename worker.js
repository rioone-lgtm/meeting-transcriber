// Web Worker: transformers.js で Whisper をブラウザ内実行(WebGPU、非対応ならWASMにフォールバック)
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

let asr = null;
let loadedModel = null;
let queue = Promise.resolve();

// Whisperが無音・雑音時に出しがちな定型ハルシネーションを除外
const HALLUCINATIONS = [
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  'チャンネル登録',
  'おやすみなさい',
  '字幕視聴ありがとうございました',
  'Thank you for watching',
  'Thanks for watching',
];

// [BLANK_AUDIO] [laughter] (音楽) ♪ など、Whisperが出力する非音声アノテーションを除去
function stripNonSpeech(text) {
  return text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^()]*\)/g, '')
    .replace(/（[^（）]*）/g, '') // 全角丸括弧
    .replace(/【[^【】]*】/g, '') // 隅付き括弧【】
    .replace(/\*[^*]+\*/g, '')
    .replace(/[♪♫♬]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    queue = queue.then(() => load(msg.model)).catch(() => {});
  } else if (msg.type === 'transcribe') {
    queue = queue.then(() => transcribe(msg)).catch(() => {});
  }
};

async function load(model) {
  if (asr && loadedModel === model) {
    self.postMessage({ type: 'ready', device: loadedDevice });
    return;
  }
  asr = null;
  const progress_callback = (p) => {
    if (p.status === 'progress') {
      self.postMessage({ type: 'progress', file: p.file, progress: p.progress || 0 });
    } else if (p.status === 'done') {
      self.postMessage({ type: 'progress', file: p.file, progress: 100 });
    }
  };
  const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
  if (hasWebGPU) {
    try {
      self.postMessage({ type: 'loading', message: 'モデルを読み込み中 (WebGPU)…' });
      asr = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback,
      });
      loadedModel = model;
      loadedDevice = 'WebGPU';
      self.postMessage({ type: 'ready', device: 'WebGPU' });
      return;
    } catch (err) {
      self.postMessage({ type: 'loading', message: 'WebGPUで失敗したためWASMで再試行中…' });
    }
  } else {
    self.postMessage({ type: 'loading', message: 'WebGPU非対応のためWASMで読み込み中…' });
  }
  try {
    asr = await pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback,
    });
    loadedModel = model;
    loadedDevice = 'WASM';
    self.postMessage({ type: 'ready', device: 'WASM' });
  } catch (err) {
    self.postMessage({ type: 'error', message: 'モデルの読み込みに失敗しました: ' + err.message });
  }
}

let loadedDevice = '';

async function transcribe({ id, audio, language }) {
  if (!asr) {
    self.postMessage({ type: 'result', id, text: '' });
    return;
  }
  try {
    const options = { task: 'transcribe' };
    if (language) options.language = language;
    const output = await asr(audio, options);
    let text = stripNonSpeech((output.text || '').trim());
    if (HALLUCINATIONS.some((h) => text.includes(h)) && audio.length < 16000 * 3) {
      text = '';
    }
    self.postMessage({ type: 'result', id, text });
  } catch (err) {
    self.postMessage({ type: 'result', id, text: '', error: String(err) });
  }
}
