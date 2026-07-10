// Microphone recorder. Captures mic input with MediaRecorder and hands back the
// recorded audio as a Blob, which the engine decodes into an AudioBuffer.
//
// Requires a secure context (HTTPS or localhost) — getUserMedia is blocked on
// plain HTTP.

/** Pick a recording container/codec the current browser actually supports. */
function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4", // Safari / iOS
    "audio/ogg;codecs=opus",
  ];
  const supported = (window as unknown as { MediaRecorder?: typeof MediaRecorder })
    .MediaRecorder?.isTypeSupported;
  if (!supported) return "";
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

export class Recorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];

  recording = false;

  /** Ask for the mic and start capturing. Throws if permission is denied. */
  async start(): Promise<void> {
    if (this.recording) return;
    // Disable the browser's voice DSP so we sample the raw sound.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.chunks = [];
    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(
      this.stream,
      mimeType ? { mimeType } : undefined,
    );
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    this.recording = true;
  }

  /** Stop capturing and resolve with the recorded audio as a Blob. */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.recorder;
      if (!rec || !this.recording) {
        reject(new Error("Not recording"));
        return;
      }
      rec.onstop = () => {
        const type = this.chunks[0]?.type || rec.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type });
        this.cleanup();
        resolve(blob);
      };
      rec.onerror = (e) => {
        this.cleanup();
        reject((e as unknown as { error?: Error }).error ?? new Error("Recorder error"));
      };
      this.recording = false;
      rec.stop();
    });
  }

  /** Abort a recording without producing a result (e.g. on teardown). */
  cancel() {
    if (this.recorder && this.recording) {
      try {
        this.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    this.cleanup();
  }

  private cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.recording = false;
  }
}
