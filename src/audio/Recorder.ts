// Microphone recorder. Captures mic input as raw PCM Float32 samples via a
// MediaStreamSource + ScriptProcessor, so we never depend on MediaRecorder codec
// support (which varies wildly across mobile browsers and causes decode failures).
//
// The resulting AudioBuffer is always valid and decodable since it IS the PCM —
// no encode/decode round-trip.

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export class Recorder {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private ctx: AudioContext | null = null;

  recording = false;

  /**
   * Ask for the mic and start capturing raw PCM.
   * @param ctx The app's AudioContext (needed to create the source node).
   */
  async start(ctx: AudioContext): Promise<void> {
    if (this.recording) return;
    this.ctx = ctx;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.chunks = [];
    this.source = ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but universally supported (including iOS).
    // Buffer size 4096 is a good balance of latency vs overhead.
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (!this.recording) return;
      // Copy the input buffer — it gets reused by the engine.
      const input = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));
    };
    this.source.connect(this.processor);
    this.processor.connect(ctx.destination); // must be connected to process
    this.recording = true;
  }

  /** Stop capturing and return the recorded audio as an AudioBuffer. */
  stop(): AudioBuffer {
    if (!this.recording || !this.ctx) throw new Error("Not recording");
    this.recording = false;
    this.cleanup();

    // Combine all chunks into one contiguous Float32Array.
    const totalLength = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];

    // Create an AudioBuffer from the raw PCM.
    const sampleRate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, totalLength, sampleRate);
    buffer.copyToChannel(merged, 0);
    return buffer;
  }

  /** Abort a recording without producing a result. */
  cancel() {
    this.recording = false;
    this.cleanup();
    this.chunks = [];
  }

  private cleanup() {
    try { this.processor?.disconnect(); } catch { /* */ }
    try { this.source?.disconnect(); } catch { /* */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this.processor = null;
  }
}
