/**
 * Moteur audio entièrement procédural (Web Audio) : aucun fichier son n'est
 * embarqué, tout est synthétisé à la volée à partir de bruit filtré et
 * d'oscillateurs.
 */

export type SoundGroup = 'stone' | 'wood' | 'grass' | 'sand' | 'gravel' | 'glass' | 'wool' | 'liquid' | 'metal';

interface GroupProfile {
  /** Fréquence centrale du filtre passe-bande. */
  freq: number;
  q: number;
  decay: number;
  gain: number;
  /** Proportion de composante tonale. */
  tone: number;
}

const PROFILES: Record<SoundGroup, GroupProfile> = {
  stone: { freq: 780, q: 1.1, decay: 0.14, gain: 0.55, tone: 0.1 },
  wood: { freq: 420, q: 2.2, decay: 0.17, gain: 0.5, tone: 0.34 },
  grass: { freq: 2600, q: 0.7, decay: 0.13, gain: 0.32, tone: 0 },
  sand: { freq: 1800, q: 0.5, decay: 0.16, gain: 0.34, tone: 0 },
  gravel: { freq: 900, q: 0.8, decay: 0.16, gain: 0.42, tone: 0.05 },
  glass: { freq: 4200, q: 3.5, decay: 0.22, gain: 0.4, tone: 0.55 },
  wool: { freq: 320, q: 0.6, decay: 0.12, gain: 0.24, tone: 0 },
  liquid: { freq: 620, q: 1.4, decay: 0.24, gain: 0.35, tone: 0.15 },
  metal: { freq: 1500, q: 5, decay: 0.3, gain: 0.42, tone: 0.7 },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noiseBuffer!: AudioBuffer;
  private started = false;

  masterVolume = 0.7;
  sfxVolume = 1;
  musicVolume = 0.35;
  muted = false;

  /** À appeler depuis un geste utilisateur (clic, touche). */
  resume(): void {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private init(): void {
    type Ctor = typeof AudioContext;
    const Ctx: Ctor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(this.ctx.destination);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this.sfxVolume;
    this.sfxBus.connect(this.master);
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(this.master);

    // Bruit blanc de 2 s réutilisé par tous les effets.
    const len = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      // Léger lissage : le bruit rose sonne plus naturel que le blanc pur.
      last = (last + 0.02 * white) / 1.02;
      data[i] = white * 0.75 + last * 4;
    }
    this.started = true;
  }

  applyVolumes(): void {
    if (!this.ctx) return;
    this.master.gain.value = this.muted ? 0 : this.masterVolume;
    this.sfxBus.gain.value = this.sfxVolume;
    this.musicBus.gain.value = this.musicVolume;
  }

  private noiseSource(): AudioBufferSourceNode | null {
    if (!this.ctx || !this.started) return null;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuffer;
    s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.5;
    return s;
  }

  /** Impact générique : bruit filtré + composante tonale. */
  private hit(profile: GroupProfile, pitch: number, volume: number, decayScale = 1): void {
    if (!this.ctx || !this.started) return;
    const t = this.ctx.currentTime;
    const decay = profile.decay * decayScale;

    const src = this.noiseSource();
    if (src) {
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = profile.freq * pitch;
      bp.Q.value = profile.q;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(profile.gain * volume, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
      src.connect(bp).connect(g).connect(this.sfxBus);
      src.start(t);
      src.stop(t + decay + 0.02);
    }

    if (profile.tone > 0.01) {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(profile.freq * pitch * 0.6, t);
      osc.frequency.exponentialRampToValueAtTime(profile.freq * pitch * 0.32, t + decay);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(profile.gain * profile.tone * volume * 0.7, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
      osc.connect(g).connect(this.sfxBus);
      osc.start(t);
      osc.stop(t + decay + 0.02);
    }
  }

  dig(group: SoundGroup, volume = 0.5): void {
    this.hit(PROFILES[group], 0.85 + Math.random() * 0.3, volume, 0.6);
  }

  break(group: SoundGroup): void {
    this.hit(PROFILES[group], 0.9 + Math.random() * 0.25, 1, 1.6);
  }

  place(group: SoundGroup): void {
    this.hit(PROFILES[group], 1.05 + Math.random() * 0.2, 0.8, 1);
  }

  step(group: SoundGroup): void {
    this.hit(PROFILES[group], 0.6 + Math.random() * 0.25, 0.28, 0.5);
  }

  /** Voix synthétique courte, utilisée pour les dégâts et les créatures. */
  private voice(freq: number, duration: number, type: OscillatorType, volume: number, slide = 0.5): void {
    if (!this.ctx || !this.started) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(volume, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0008, t + duration);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  hurt(): void {
    this.voice(240, 0.28, 'sawtooth', 0.34, 0.45);
  }

  mobHurt(kind: string): void {
    const base = kind === 'chicken' ? 780 : kind === 'zombie' ? 170 : kind === 'creeper' ? 300 : 420;
    this.voice(base, 0.22, 'square', 0.22, 0.7);
  }

  mobAmbient(kind: string): void {
    const base = kind === 'chicken' ? 900 : kind === 'cow' ? 150 : kind === 'pig' ? 260 : kind === 'zombie' ? 130 : 350;
    this.voice(base * (0.9 + Math.random() * 0.25), 0.5, kind === 'zombie' ? 'sawtooth' : 'triangle', 0.14, 0.8);
  }

  splash(): void {
    this.hit(PROFILES.liquid, 1.4, 0.9, 2.2);
  }

  eat(): void {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.hit(PROFILES.wool, 1.3, 0.5, 0.6), i * 110);
    }
  }

  craft(): void {
    this.voice(660, 0.1, 'square', 0.16, 1.5);
    setTimeout(() => this.voice(880, 0.12, 'square', 0.14, 1.2), 70);
  }

  click(): void {
    this.voice(1100, 0.05, 'square', 0.12, 1);
  }

  levelUp(): void {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.voice(f, 0.28, 'triangle', 0.16, 1), i * 90));
  }

  explosion(): void {
    if (!this.ctx || !this.started) return;
    const t = this.ctx.currentTime;
    const src = this.noiseSource();
    if (!src) return;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 1.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.85, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    src.connect(lp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 1.5);
  }

  /** Nappe d'ambiance douce, jouée en fond selon l'heure du jour. */
  private ambientOsc: OscillatorNode[] = [];
  setAmbience(active: boolean, night: boolean): void {
    if (!this.ctx || !this.started) return;
    if (!active) {
      for (const o of this.ambientOsc) {
        try { o.stop(); } catch { /* déjà arrêté */ }
      }
      this.ambientOsc = [];
      return;
    }
    if (this.ambientOsc.length) return;
    const t = this.ctx.currentTime;
    const chord = night ? [110, 164.81, 196] : [130.81, 196, 261.63];
    for (const f of chord) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.035, t + 4);
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.06 + Math.random() * 0.05;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 0.02;
      lfo.connect(lfoGain).connect(g.gain);
      lfo.start(t);
      osc.connect(g).connect(this.musicBus);
      osc.start(t);
      this.ambientOsc.push(osc, lfo);
    }
  }
}
