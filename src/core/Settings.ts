/** Réglages persistés dans le stockage local. */

export interface Settings {
  renderDistance: number;
  fov: number;
  sensitivity: number;
  invertY: boolean;
  bloom: boolean;
  godRays: boolean;
  fxaa: boolean;
  /** Échelle de rendu (super/sous-échantillonnage). */
  resolutionScale: number;
  smoothLighting: boolean;
  clouds: boolean;
  weather: boolean;
  particles: boolean;
  viewBobbing: boolean;
  autoJump: boolean;
  showFps: boolean;
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  muted: boolean;
  guiScale: number;
  entityDistance: number;
  maxMobs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  renderDistance: 8,
  fov: 75,
  sensitivity: 1,
  invertY: false,
  bloom: true,
  godRays: true,
  fxaa: true,
  resolutionScale: 1,
  smoothLighting: true,
  clouds: true,
  weather: true,
  particles: true,
  viewBobbing: true,
  autoJump: false,
  showFps: false,
  masterVolume: 0.7,
  sfxVolume: 1,
  musicVolume: 0.3,
  muted: false,
  guiScale: 1,
  entityDistance: 64,
  maxMobs: 32,
};

const KEY = 'voxelcraft.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Stockage indisponible (navigation privée) : on continue sans persister.
  }
}

/** Détecte un appareil probablement tactile pour adapter l'interface. */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
}
