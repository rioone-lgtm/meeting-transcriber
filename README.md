# 会議文字起こし(ブラウザ内Whisper版)

Google Meet / Zoom などブラウザで実施している会議のタブ音声とマイク音声を、
**ブラウザ内で動くWhisper(transformers.js + WebGPU)** で文字起こしする静的Webアプリです。

- バックエンド不要(静的ファイルのみ)・API費用ゼロ
- 音声データは外部に送信されません(モデルファイルのダウンロードのみ通信が発生)
- マイク=「自分」、タブ音声=「相手」として話者ラベル付きで表示
- 日本語以外の発話は、Chrome内蔵の翻訳AI(Translator API、Chrome 138以降)で
  原文の下に日本語訳を並記(こちらもローカル処理・外部送信なし)

## 起動方法

`getDisplayMedia` / WebGPU は secure context が必須のため、ローカルサーバーで配信します。

```
npx -y serve -l 3333 meeting-transcriber
```

→ Chrome または Edge で http://localhost:3333 を開く

## 使い方

1. 会議をブラウザの別タブで開始する
2. 「文字起こしを開始」→ 共有ダイアログで会議中の**タブ**を選択し、
   **「タブの音声も共有する」に必ずチェック**して共有
   (モデルは開始ボタンを押した時点で裏で読み込まれる。初回のみ数十MBのダウンロードあり)
3. 会議終了後「停止」→「テキストを保存」で .txt をダウンロード

## 制約・注意

- **Chrome / Edge 限定**(Firefox・Safariはタブ音声を取得できない)
- デスクトップアプリ版のZoom等は対象外(ブラウザで会議に参加する必要あり)
- 録音・文字起こしは事前に会議参加者へ告知すること
- whisper-base は速度優先。精度が足りなければ whisper-small を選択(GPU性能次第)
- 精度・安定性を上げたくなったら、STTをクラウドAPI(Deepgram / AssemblyAI等)に
  差し替える構成が次のステップ

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | UI |
| `app.js` | 音声キャプチャ(getDisplayMedia / getUserMedia)、無音検出によるセグメント分割 |
| `pcm-processor.js` | AudioWorklet。16kHz PCM をメインスレッドへ転送 |
| `worker.js` | Web Worker。transformers.js の Whisper で音声認識(WebGPU→WASMフォールバック) |
