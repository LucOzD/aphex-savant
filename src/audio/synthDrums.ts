// Procedurally-generated drum sounds so every pad makes noise out of the box,
// before the user loads any of their own samples. Rendered straight into
// AudioBuffers (no files to ship).

type Kind = "kick" | "snare" | "hat" | "openhat" | "clap" | "tom" | "rim" | "cowbell";

const KIND_ORDER: Kind[] = ["kick", "snare", "hat", "clap", "tom", "openhat", "rim", "cowbell"];

function env(i: number, len: number, decay: number): number {
  return Math.pow(1 - i / len, decay);
}

function render(ctx: BaseAudioContext, kind: Kind, seed: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const dur = kind === "openhat" ? 0.4 : kind === "kick" || kind === "tom" ? 0.5 : 0.25;
  const len = Math.floor(dur * rate);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  const rnd = mulberry32(seed);

  switch (kind) {
    case "kick": {
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        const freq = 120 * Math.exp(-t * 24) + 45; // pitch sweep down
        phase += (2 * Math.PI * freq) / rate;
        d[i] = Math.sin(phase) * env(i, len, 3.5);
      }
      break;
    }
    case "tom": {
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        const freq = 180 * Math.exp(-t * 10) + 90;
        phase += (2 * Math.PI * freq) / rate;
        d[i] = Math.sin(phase) * env(i, len, 4);
      }
      break;
    }
    case "snare": {
      let phase = 0;
      for (let i = 0; i < len; i++) {
        phase += (2 * Math.PI * 190) / rate;
        const tone = Math.sin(phase) * 0.4;
        const noise = (rnd() * 2 - 1) * 0.9;
        d[i] = (tone + noise) * env(i, len, 6);
      }
      break;
    }
    case "clap": {
      // Three quick noise bursts.
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        let a = 0;
        for (const off of [0, 0.01, 0.02]) {
          if (t >= off) a += Math.pow(1 - Math.min(1, (t - off) / 0.12), 8);
        }
        d[i] = (rnd() * 2 - 1) * Math.min(1, a);
      }
      break;
    }
    case "hat":
    case "openhat": {
      const decay = kind === "hat" ? 30 : 8;
      let prev = 0;
      for (let i = 0; i < len; i++) {
        const white = rnd() * 2 - 1;
        // Crude high-pass: emphasise the difference between samples.
        const hp = white - prev;
        prev = white;
        d[i] = hp * env(i, len, decay);
      }
      break;
    }
    case "rim": {
      let phase = 0;
      for (let i = 0; i < len; i++) {
        phase += (2 * Math.PI * 1700) / rate;
        d[i] = Math.sin(phase) * env(i, len, 40);
      }
      break;
    }
    case "cowbell": {
      let p1 = 0;
      let p2 = 0;
      for (let i = 0; i < len; i++) {
        p1 += (2 * Math.PI * 540) / rate;
        p2 += (2 * Math.PI * 800) / rate;
        const sq = (Math.sign(Math.sin(p1)) + Math.sign(Math.sin(p2))) * 0.5;
        d[i] = sq * env(i, len, 6);
      }
      break;
    }
  }

  // Normalise + tiny fade to avoid clicks.
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  const norm = peak > 0 ? 0.9 / peak : 1;
  const fade = Math.min(64, len);
  for (let i = 0; i < len; i++) {
    let g = norm;
    if (i < fade) g *= i / fade;
    d[i] *= g;
  }
  return buf;
}

/** Deterministic PRNG so generated drums sound identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate `count` drum buffers, cycling through the kinds. */
export function generateDrumKit(ctx: BaseAudioContext, count: number): AudioBuffer[] {
  const out: AudioBuffer[] = [];
  for (let i = 0; i < count; i++) {
    const kind = KIND_ORDER[i % KIND_ORDER.length];
    out.push(render(ctx, kind, i + 1));
  }
  return out;
}

export function drumName(index: number): string {
  const kind = KIND_ORDER[index % KIND_ORDER.length];
  const round = Math.floor(index / KIND_ORDER.length);
  return round > 0 ? `${kind} ${round + 1}` : kind;
}
