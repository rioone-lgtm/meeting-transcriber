// AudioWorklet: 入力PCM (Float32) を約2048サンプルごとにまとめてメインスレッドへ送る
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = [];
    this.length = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      this.buffers.push(new Float32Array(channel));
      this.length += channel.length;
      if (this.length >= 2048) {
        const out = new Float32Array(this.length);
        let offset = 0;
        for (const b of this.buffers) {
          out.set(b, offset);
          offset += b.length;
        }
        this.port.postMessage(out, [out.buffer]);
        this.buffers = [];
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
