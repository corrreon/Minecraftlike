/**
 * Génération procédurale de l'atlas de textures.
 *
 * Le jeu n'embarque aucune image : chaque tuile 16×16 est peinte au démarrage
 * dans un `DataArrayTexture`, ce qui supprime tout saignement d'atlas et
 * autorise le mip-mapping propre par couche.
 */

import {
  DataArrayTexture,
  LinearMipmapLinearFilter,
  NearestFilter,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { TEXTURE_NAMES } from '../world/blocks';
import { mulberry32 } from '../world/noise';

export const TILE = 16;
const STRIDE = TILE * TILE * 4;

type RGB = [number, number, number];

const rgb = (hex: number): RGB => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

class Tile {
  readonly data = new Uint8Array(STRIDE);

  set(x: number, y: number, c: RGB, a = 255, mul = 1): void {
    const i = (y * TILE + x) * 4;
    this.data[i] = clamp255(c[0] * mul);
    this.data[i + 1] = clamp255(c[1] * mul);
    this.data[i + 2] = clamp255(c[2] * mul);
    this.data[i + 3] = a;
  }

  get(x: number, y: number): RGB {
    const i = (((y % TILE) + TILE) % TILE) * TILE * 4 + (((x % TILE) + TILE) % TILE) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  alphaAt(x: number, y: number): number {
    return this.data[(y * TILE + x) * 4 + 3];
  }

  fill(c: RGB, a = 255): void {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) this.set(x, y, c, a);
  }

  clear(): void {
    this.data.fill(0);
  }

  /** Assombrit ou éclaircit un pixel existant. */
  mul(x: number, y: number, f: number): void {
    const i = (y * TILE + x) * 4;
    this.data[i] = clamp255(this.data[i] * f);
    this.data[i + 1] = clamp255(this.data[i + 1] * f);
    this.data[i + 2] = clamp255(this.data[i + 2] * f);
  }
}

/** Bruit de valeur bouclable sur la tuile (pas de couture entre blocs). */
function tileNoise(cells: number, rnd: () => number): Float32Array {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const out = new Float32Array(TILE * TILE);
  const scale = cells / TILE;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const fx = x * scale, fy = y * scale;
      const x0 = Math.floor(fx) % cells, y0 = Math.floor(fy) % cells;
      const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
      const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[y0 * cells + x0] * (1 - sx) + g[y0 * cells + x1] * sx;
      const b = g[y1 * cells + x0] * (1 - sx) + g[y1 * cells + x1] * sx;
      out[y * TILE + x] = a * (1 - sy) + b * sy;
    }
  }
  return out;
}

function fbmTile(rnd: () => number, octaves = 3): Float32Array {
  const out = new Float32Array(TILE * TILE);
  let amp = 1, norm = 0, cells = 2;
  for (let o = 0; o < octaves; o++) {
    const n = tileNoise(cells, rnd);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    norm += amp;
    amp *= 0.5;
    cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Remplit avec une couleur modulée par un bruit fractal. */
function grainy(t: Tile, base: RGB, rnd: () => number, amount = 0.22, octaves = 3): void {
  const n = fbmTile(rnd, octaves);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const f = 1 - amount * 0.5 + n[y * TILE + x] * amount;
      t.set(x, y, base, 255, f);
    }
  }
}

/** Taches de couleur pilotées par le bruit (minerais, mousse…). */
function blotch(t: Tile, color: RGB, rnd: () => number, threshold: number, cells = 4, jitter = 0.12): void {
  const n = tileNoise(cells, rnd);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (n[y * TILE + x] > threshold) t.set(x, y, color, 255, 0.9 + rnd() * jitter * 2);
    }
  }
}

function speckle(t: Tile, color: RGB, rnd: () => number, count: number, dark = 1): void {
  for (let i = 0; i < count; i++) {
    const x = (rnd() * TILE) | 0;
    const y = (rnd() * TILE) | 0;
    t.set(x, y, color, 255, dark);
  }
}

/** Motif de cellules irrégulières (pierre taillée, gravier). */
function cellular(t: Tile, base: RGB, rnd: () => number, seeds: number, edge = 0.55, variance = 0.3): void {
  const px: number[] = [], py: number[] = [], pv: number[] = [];
  for (let i = 0; i < seeds; i++) {
    px.push(rnd() * TILE);
    py.push(rnd() * TILE);
    pv.push(1 - variance * 0.5 + rnd() * variance);
  }
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let d0 = 1e9, d1 = 1e9, best = 0;
      for (let i = 0; i < seeds; i++) {
        // Distance torique pour un motif qui se raccorde.
        let dx = Math.abs(px[i] - x - 0.5);
        let dy = Math.abs(py[i] - y - 0.5);
        if (dx > TILE / 2) dx = TILE - dx;
        if (dy > TILE / 2) dy = TILE - dy;
        const d = dx * dx + dy * dy;
        if (d < d0) { d1 = d0; d0 = d; best = i; }
        else if (d < d1) d1 = d;
      }
      const border = Math.sqrt(d1) - Math.sqrt(d0);
      const f = border < edge ? 0.55 : pv[best];
      t.set(x, y, base, 255, f);
    }
  }
}

function stripes(t: Tile, base: RGB, rnd: () => number, period: number, vertical: boolean): void {
  const n = fbmTile(rnd, 3);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const axis = vertical ? x : y;
      const inBand = axis % period;
      let f = 0.92 + n[y * TILE + x] * 0.18;
      if (inBand === 0) f *= 0.68; // rainure entre les planches
      // Veinage.
      const grain = vertical ? n[((y * 3) % TILE) * TILE + x] : n[y * TILE + ((x * 3) % TILE)];
      if (grain > 0.72) f *= 0.86;
      t.set(x, y, base, 255, f);
    }
  }
}

function brickPattern(t: Tile, base: RGB, mortar: RGB, rnd: () => number): void {
  const n = fbmTile(rnd, 2);
  for (let y = 0; y < TILE; y++) {
    const row = (y / 4) | 0;
    const offset = row % 2 === 0 ? 0 : 4;
    for (let x = 0; x < TILE; x++) {
      const isMortar = y % 4 === 0 || (x + offset) % 8 === 0;
      const c = isMortar ? mortar : base;
      t.set(x, y, c, 255, 0.9 + n[y * TILE + x] * 0.25);
    }
  }
}

function ringPattern(t: Tile, base: RGB, ring: RGB, rnd: () => number): void {
  const n = fbmTile(rnd, 2);
  const cx = 7.5, cy = 7.5;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = Math.hypot(x - cx, y - cy) + n[y * TILE + x] * 1.5;
      const r = Math.round(d) % 3 === 0;
      t.set(x, y, r ? ring : base, 255, 0.9 + n[y * TILE + x] * 0.22);
    }
  }
}

/** Silhouette de plante : tiges verticales bruitées, fond transparent. */
function plant(t: Tile, stem: RGB, rnd: () => number, blades: number, height: number): void {
  t.clear();
  for (let i = 0; i < blades; i++) {
    let x = 1 + ((rnd() * (TILE - 2)) | 0);
    const h = height * (0.6 + rnd() * 0.4);
    const dir = rnd() < 0.5 ? -1 : 1;
    for (let k = 0; k < h; k++) {
      const y = TILE - 1 - k;
      if (y < 0) break;
      if (k > h * 0.45 && rnd() < 0.35) x += dir;
      if (x < 0 || x >= TILE) break;
      const f = 0.7 + (k / h) * 0.5;
      t.set(x, y, stem, 255, f);
      if (rnd() < 0.35 && x + 1 < TILE) t.set(x + 1, y, stem, 255, f * 0.85);
    }
  }
}

function flower(t: Tile, stem: RGB, petal: RGB, centerC: RGB, rnd: () => number): void {
  t.clear();
  const cx = 7 + ((rnd() * 2) | 0);
  for (let y = 8; y < TILE; y++) t.set(cx, y, stem, 255, 0.8 + rnd() * 0.3);
  t.set(cx - 1, 11, stem, 255, 0.7);
  t.set(cx + 1, 13, stem, 255, 0.7);
  const cy = 5;
  const pts: [number, number][] = [
    [0, -2], [0, -1], [-1, -1], [1, -1], [-2, 0], [-1, 0], [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2],
  ];
  for (const [dx, dy] of pts) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || x >= TILE || y < 0 || y >= TILE) continue;
    t.set(x, y, petal, 255, 0.85 + rnd() * 0.3);
  }
  t.set(cx, cy, centerC, 255);
}

// ---------------------------------------------------------------------------
// Peintres par nom de texture.
// ---------------------------------------------------------------------------

const PAINTERS: Record<string, (t: Tile, rnd: () => number) => void> = {
  air: (t) => t.clear(),
  missing: (t) => {
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++)
        t.set(x, y, (x >> 3) % 2 === (y >> 3) % 2 ? [0, 0, 0] : [248, 0, 248]);
  },

  stone: (t, r) => { grainy(t, rgb(0x7f7f7f), r, 0.28, 4); speckle(t, rgb(0x6a6a6a), r, 12, 1); },
  andesite: (t, r) => { grainy(t, rgb(0x898b89), r, 0.2, 4); speckle(t, rgb(0x74766f), r, 20, 1); },
  granite: (t, r) => { grainy(t, rgb(0x9a6b5c), r, 0.22, 4); speckle(t, rgb(0xb08b7b), r, 22, 1); },
  diorite: (t, r) => { grainy(t, rgb(0xcfcfcf), r, 0.2, 4); speckle(t, rgb(0xa8a8a8), r, 22, 1); },
  cobblestone: (t, r) => { cellular(t, rgb(0x7d7d7d), r, 7, 0.7, 0.36); speckle(t, rgb(0x616161), r, 10, 1); },
  mossy_cobblestone: (t, r) => { cellular(t, rgb(0x7d7d7d), r, 7, 0.7, 0.36); blotch(t, rgb(0x51702f), r, 0.52, 4, 0.2); },
  stone_bricks: (t, r) => brickPattern(t, rgb(0x7b7b7b), rgb(0x5f5f5f), r),
  bricks: (t, r) => brickPattern(t, rgb(0x9a5b48), rgb(0xb9ada6), r),
  bedrock: (t, r) => { cellular(t, rgb(0x565656), r, 10, 0.55, 0.6); speckle(t, rgb(0x2a2a2a), r, 26, 1); },
  obsidian: (t, r) => { grainy(t, rgb(0x14101f), r, 0.5, 3); speckle(t, rgb(0x4a3a72), r, 10, 1); },

  dirt: (t, r) => { grainy(t, rgb(0x866043), r, 0.3, 4); speckle(t, rgb(0x6b4a31), r, 18, 1); },
  coarse_dirt: (t, r) => { grainy(t, rgb(0x77543a), r, 0.36, 4); speckle(t, rgb(0x5d4029), r, 26, 1); },
  grass_top: (t, r) => { grainy(t, rgb(0xffffff), r, 0.24, 4); speckle(t, rgb(0xdadada), r, 18, 1); },
  grass_side: (t, r) => {
    grainy(t, rgb(0x866043), r, 0.3, 4);
    const n = fbmTile(r, 3);
    for (let x = 0; x < TILE; x++) {
      const h = 3 + Math.round(n[x] * 3);
      for (let y = 0; y < h; y++) t.set(x, y, rgb(0xffffff), 255, 0.82 + n[y * TILE + x] * 0.3);
    }
  },
  sand: (t, r) => { grainy(t, rgb(0xdcd0a0), r, 0.16, 4); speckle(t, rgb(0xc9bb87), r, 16, 1); },
  red_sand: (t, r) => { grainy(t, rgb(0xbe6c31), r, 0.16, 4); speckle(t, rgb(0xa85a26), r, 16, 1); },
  gravel: (t, r) => { cellular(t, rgb(0x847e7c), r, 12, 0.5, 0.55); speckle(t, rgb(0x5b5654), r, 16, 1); },
  clay: (t, r) => grainy(t, rgb(0xa0a5b3), r, 0.14, 3),
  snow: (t, r) => { grainy(t, rgb(0xf3f8f8), r, 0.08, 3); speckle(t, rgb(0xdfe9ef), r, 8, 1); },

  sandstone: (t, r) => {
    grainy(t, rgb(0xd9cca3), r, 0.12, 3);
    for (let x = 0; x < TILE; x++) { t.mul(x, 0, 0.82); t.mul(x, TILE - 1, 0.9); t.mul(x, 5, 0.93); t.mul(x, 11, 0.93); }
  },
  sandstone_top: (t, r) => grainy(t, rgb(0xe0d3ac), r, 0.1, 4),
  sandstone_bottom: (t, r) => grainy(t, rgb(0xc7b98f), r, 0.14, 4),

  water: (t, r) => {
    const n = fbmTile(r, 3);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) t.set(x, y, rgb(0x3a6fd8), 205, 0.85 + n[y * TILE + x] * 0.35);
  },
  ice: (t, r) => {
    const n = fbmTile(r, 3);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) t.set(x, y, rgb(0xa5cdf5), 190, 0.88 + n[y * TILE + x] * 0.28);
  },
  packed_ice: (t, r) => grainy(t, rgb(0x8fbdf0), r, 0.14, 3),
  lava: (t, r) => {
    const n = fbmTile(r, 3);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const v = n[y * TILE + x];
        t.set(x, y, v > 0.62 ? rgb(0xffd23a) : v > 0.42 ? rgb(0xef7215) : rgb(0xc63d05), 255, 0.9 + v * 0.3);
      }
  },

  glass: (t, r) => {
    t.clear();
    for (let i = 0; i < TILE; i++) {
      t.set(i, 0, rgb(0xd6f2ff), 190);
      t.set(i, TILE - 1, rgb(0xd6f2ff), 190);
      t.set(0, i, rgb(0xd6f2ff), 190);
      t.set(TILE - 1, i, rgb(0xd6f2ff), 190);
    }
    for (let i = 0; i < 5; i++) {
      const x = 2 + ((r() * 11) | 0);
      const y = 2 + ((r() * 11) | 0);
      t.set(x, y, rgb(0xffffff), 120);
      t.set(x + 1, y + 1, rgb(0xffffff), 90);
    }
  },

  oak_planks: (t, r) => stripes(t, rgb(0xb08a55), r, 4, false),
  birch_planks: (t, r) => stripes(t, rgb(0xd7cb8d), r, 4, false),
  spruce_planks: (t, r) => stripes(t, rgb(0x7a5b36), r, 4, false),
  jungle_planks: (t, r) => stripes(t, rgb(0xb17f5f), r, 4, false),
  oak_log: (t, r) => stripes(t, rgb(0x6b5231), r, 5, true),
  birch_log: (t, r) => { stripes(t, rgb(0xd8d6cf), r, 6, true); speckle(t, rgb(0x33322c), r, 14, 1); },
  spruce_log: (t, r) => stripes(t, rgb(0x4c3a22), r, 5, true),
  jungle_log: (t, r) => stripes(t, rgb(0x584220), r, 5, true),
  oak_log_top: (t, r) => ringPattern(t, rgb(0xa0813f), rgb(0x8a6b32), r),
  birch_log_top: (t, r) => ringPattern(t, rgb(0xd7cb8d), rgb(0xbcb078), r),
  spruce_log_top: (t, r) => ringPattern(t, rgb(0x7a5b36), rgb(0x62492b), r),
  jungle_log_top: (t, r) => ringPattern(t, rgb(0xb17f5f), rgb(0x94674a), r),
  bookshelf: (t, r) => {
    stripes(t, rgb(0xb08a55), r, 8, false);
    const colors = [rgb(0xa63b2c), rgb(0x3b6ea6), rgb(0xd0b64c), rgb(0x4a8a3f), rgb(0x8a4aa1)];
    for (const rowY of [2, 10]) {
      let x = 0;
      while (x < TILE) {
        const w = 1 + ((r() * 2) | 0);
        const c = colors[(r() * colors.length) | 0];
        for (let dx = 0; dx < w && x + dx < TILE; dx++)
          for (let dy = 0; dy < 5; dy++) t.set(x + dx, rowY + dy, c, 255, 0.8 + r() * 0.35);
        x += w + 1;
      }
    }
  },

  oak_leaves: (t, r) => leaves(t, r, 0xffffff),
  birch_leaves: (t, r) => leaves(t, r, 0xffffff),
  spruce_leaves: (t, r) => leaves(t, r, 0xffffff),
  jungle_leaves: (t, r) => leaves(t, r, 0xffffff),

  coal_ore: (t, r) => oreTile(t, r, 0x1b1b1b),
  iron_ore: (t, r) => oreTile(t, r, 0xcfa387),
  gold_ore: (t, r) => oreTile(t, r, 0xf6d34a),
  diamond_ore: (t, r) => oreTile(t, r, 0x4ae2dc),
  emerald_ore: (t, r) => oreTile(t, r, 0x2fd15b),
  redstone_ore: (t, r) => oreTile(t, r, 0xd42a2a),
  lapis_ore: (t, r) => oreTile(t, r, 0x2452c4),

  coal_block: (t, r) => { grainy(t, rgb(0x1a1a1a), r, 0.35, 4); speckle(t, rgb(0x3a3a3a), r, 14, 1); },
  iron_block: (t, r) => metalTile(t, r, 0xd8d8d8),
  gold_block: (t, r) => metalTile(t, r, 0xf7d84c),
  diamond_block: (t, r) => metalTile(t, r, 0x62e8e0),
  emerald_block: (t, r) => metalTile(t, r, 0x3ddb6a),
  lapis_block: (t, r) => { grainy(t, rgb(0x2a55c6), r, 0.28, 4); speckle(t, rgb(0x18378c), r, 18, 1); },
  redstone_block: (t, r) => { grainy(t, rgb(0xb31d1d), r, 0.3, 4); speckle(t, rgb(0x7d1010), r, 20, 1); },

  glowstone: (t, r) => {
    grainy(t, rgb(0xd6a441), r, 0.22, 3);
    blotch(t, rgb(0xffe9a8), r, 0.58, 3, 0.2);
  },
  sea_lantern: (t, r) => { grainy(t, rgb(0xb9e3dc), r, 0.16, 3); blotch(t, rgb(0xeafffb), r, 0.55, 3); },

  crafting_top: (t, r) => {
    stripes(t, rgb(0xb08a55), r, 4, false);
    for (let i = 0; i < TILE; i++) { t.mul(i, 5, 0.6); t.mul(i, 10, 0.6); t.mul(5, i, 0.6); t.mul(10, i, 0.6); }
  },
  crafting_side: (t, r) => {
    stripes(t, rgb(0x9c7a4a), r, 4, false);
    for (let x = 3; x < 13; x++) { t.mul(x, 4, 0.65); t.mul(x, 11, 0.65); }
    for (let y = 4; y < 12; y++) { t.mul(3, y, 0.65); t.mul(12, y, 0.65); }
  },
  furnace_top: (t, r) => { cellular(t, rgb(0x707070), r, 6, 0.6, 0.25); },
  furnace_front: (t, r) => {
    cellular(t, rgb(0x707070), r, 6, 0.6, 0.25);
    for (let y = 6; y < 13; y++) for (let x = 4; x < 12; x++) t.set(x, y, rgb(0x2a2a2a), 255, 0.9 + r() * 0.2);
    for (let x = 5; x < 11; x++) t.set(x, 12, rgb(0x5a5a5a), 255);
  },
  chest_top: (t, r) => stripes(t, rgb(0x9a6a34), r, 5, false),
  chest_side: (t, r) => {
    stripes(t, rgb(0x8a5c2c), r, 6, false);
    for (let x = 0; x < TILE; x++) t.mul(x, 6, 0.55);
    for (let y = 4; y < 9; y++) { t.set(7, y, rgb(0x3a3128)); t.set(8, y, rgb(0x2a2a2a)); }
  },
  tnt_top: (t, r) => { grainy(t, rgb(0xb03b2c), r, 0.18, 3); for (let i = 0; i < TILE; i++) t.mul(i, 0, 0.7); },
  tnt_bottom: (t, r) => grainy(t, rgb(0x6b4a35), r, 0.18, 3),
  tnt_side: (t, r) => {
    grainy(t, rgb(0xb03b2c), r, 0.18, 3);
    for (let y = 5; y < 11; y++) for (let x = 0; x < TILE; x++) t.set(x, y, rgb(0xf0f0f0), 255, 0.9 + r() * 0.2);
    for (let x = 2; x < 14; x++) { t.set(x, 7, rgb(0x1a1a1a)); t.set(x, 8, rgb(0x1a1a1a)); }
  },
  pumpkin_top: (t, r) => { grainy(t, rgb(0xc47418), r, 0.2, 3); for (let i = 0; i < 4; i++) t.set(7 + (i % 2), 7 + ((i / 2) | 0), rgb(0x6f5a22)); },
  pumpkin_side: (t, r) => {
    grainy(t, rgb(0xd2801c), r, 0.16, 3);
    for (let x = 0; x < TILE; x += 4) for (let y = 0; y < TILE; y++) t.mul(x, y, 0.78);
  },
  jack_o_lantern: (t, r) => {
    grainy(t, rgb(0xd2801c), r, 0.16, 3);
    for (let x = 0; x < TILE; x += 4) for (let y = 0; y < TILE; y++) t.mul(x, y, 0.78);
    const face = [
      [4, 5], [5, 5], [4, 6], [10, 5], [11, 5], [11, 6],
      [4, 10], [5, 11], [6, 11], [7, 10], [8, 11], [9, 11], [10, 10], [11, 10],
    ];
    for (const [x, y] of face) t.set(x, y, rgb(0xffe27a));
  },
  melon_top: (t, r) => grainy(t, rgb(0x6f9b32), r, 0.2, 3),
  melon_side: (t, r) => {
    grainy(t, rgb(0x6f9b32), r, 0.22, 3);
    const n = fbmTile(r, 3);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (n[y * TILE + x] > 0.6) t.set(x, y, rgb(0x9bc255), 255, 0.9);
  },

  cactus_top: (t, r) => { grainy(t, rgb(0x577d2e), r, 0.16, 3); speckle(t, rgb(0xd8e3b0), r, 6, 1); },
  cactus_bottom: (t, r) => grainy(t, rgb(0x6b5a3a), r, 0.16, 3),
  cactus_side: (t, r) => {
    grainy(t, rgb(0x4f7a2a), r, 0.14, 3);
    for (let y = 0; y < TILE; y++) { t.mul(0, y, 0.7); t.mul(TILE - 1, y, 0.7); }
    for (let y = 1; y < TILE; y += 4) { t.set(4, y, rgb(0xdfe8c0), 255); t.set(11, y + 2, rgb(0xdfe8c0), 255); }
  },

  wool: (t, r) => { grainy(t, rgb(0xffffff), r, 0.14, 4); speckle(t, rgb(0xe8e8e8), r, 20, 1); },

  tall_grass: (t, r) => plant(t, rgb(0xffffff), r, 7, 13),
  fern: (t, r) => plant(t, rgb(0xffffff), r, 5, 11),
  wheat: (t, r) => plant(t, rgb(0xd8c25a), r, 6, 13),
  sugar_cane: (t, r) => plant(t, rgb(0xffffff), r, 4, 16),
  dead_bush: (t, r) => plant(t, rgb(0x8a6b33), r, 6, 10),
  dandelion: (t, r) => flower(t, rgb(0x4c8a32), rgb(0xf4d63b), rgb(0xfff3a0), r),
  poppy: (t, r) => flower(t, rgb(0x4c8a32), rgb(0xd23b2c), rgb(0x2a2a2a), r),
  blue_orchid: (t, r) => flower(t, rgb(0x4c8a32), rgb(0x2fa9e0), rgb(0xf0f8ff), r),
  brown_mushroom: (t, r) => mushroom(t, r, 0x9b7050, 0xc8a887),
  red_mushroom: (t, r) => mushroom(t, r, 0xd23b2c, 0xf0f0f0),
  oak_sapling: (t, r) => sapling(t, r),
  birch_sapling: (t, r) => sapling(t, r),
  spruce_sapling: (t, r) => sapling(t, r),
  jungle_sapling: (t, r) => sapling(t, r),
  torch: (t, r) => {
    t.clear();
    for (let y = 6; y < TILE; y++) { t.set(7, y, rgb(0x8a6a3a), 255, 0.85 + r() * 0.25); t.set(8, y, rgb(0x6d5129), 255); }
    t.set(7, 5, rgb(0xffe08a));
    t.set(8, 5, rgb(0xffc84a));
    t.set(7, 4, rgb(0xfff3c4));
    t.set(8, 4, rgb(0xffe08a));
  },
};

function leaves(t: Tile, r: () => number, base: number): void {
  const n = fbmTile(r, 3);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const v = n[y * TILE + x];
      if (v < 0.30) t.set(x, y, rgb(base), 0);
      else t.set(x, y, rgb(base), 255, 0.62 + v * 0.62);
    }
  }
}

function oreTile(t: Tile, r: () => number, ore: number): void {
  grainy(t, rgb(0x7f7f7f), r, 0.26, 4);
  const n = tileNoise(4, r);
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const v = n[y * TILE + x];
      if (v > 0.68) t.set(x, y, rgb(ore), 255, 0.85 + v * 0.35);
      else if (v > 0.62) t.set(x, y, rgb(ore), 255, 0.6);
    }
}

function metalTile(t: Tile, r: () => number, base: number): void {
  grainy(t, rgb(base), r, 0.1, 3);
  for (let i = 0; i < TILE; i++) { t.mul(i, 0, 1.12); t.mul(0, i, 1.1); t.mul(i, TILE - 1, 0.85); t.mul(TILE - 1, i, 0.88); }
}

function mushroom(t: Tile, r: () => number, cap: number, spot: number): void {
  t.clear();
  for (let y = 9; y < TILE; y++) { t.set(7, y, rgb(0xe0d8c0), 255, 0.85 + r() * 0.2); t.set(8, y, rgb(0xc8bfa4), 255); }
  for (let y = 4; y < 10; y++) {
    const w = y < 6 ? 3 : y < 8 ? 5 : 4;
    for (let x = 8 - w; x <= 7 + w; x++) {
      if (x < 0 || x >= TILE) continue;
      t.set(x, y, rgb(cap), 255, 0.85 + r() * 0.3);
    }
  }
  for (let i = 0; i < 4; i++) t.set(4 + ((r() * 8) | 0), 5 + ((r() * 4) | 0), rgb(spot), 255);
}

function sapling(t: Tile, r: () => number): void {
  t.clear();
  for (let y = 10; y < TILE; y++) t.set(7, y, rgb(0x6b4a2a), 255, 0.9);
  const pts: [number, number][] = [[7, 4], [6, 5], [8, 5], [5, 6], [7, 6], [9, 6], [6, 7], [8, 7], [7, 8], [5, 8], [9, 8], [7, 9]];
  for (const [x, y] of pts) t.set(x, y, rgb(0xffffff), 255, 0.75 + r() * 0.4);
}

export interface Atlas {
  texture: DataArrayTexture;
  layerCount: number;
  /** Aperçu RGBA d'une tuile, pour les icônes d'inventaire. */
  tileData(layer: number): Uint8Array;
  /** Couleur moyenne d'une tuile (0xRRGGBB), utilisée par les particules. */
  tileAverage(layer: number): number;
}

export function buildAtlas(): Atlas {
  const count = TEXTURE_NAMES.length;
  const data = new Uint8Array(STRIDE * count);
  const previews: Uint8Array[] = [];

  for (let i = 0; i < count; i++) {
    const name = TEXTURE_NAMES[i];
    const t = new Tile();
    const painter = PAINTERS[name] ?? PAINTERS.missing;
    // Graine dérivée du nom : la même texture est reproduite à l'identique.
    let h = 2166136261;
    for (let k = 0; k < name.length; k++) h = Math.imul(h ^ name.charCodeAt(k), 16777619);
    painter(t, mulberry32(h >>> 0));
    data.set(t.data, i * STRIDE);
    previews.push(t.data);
  }

  const texture = new DataArrayTexture(data, TILE, TILE, count);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const averages = previews.map((d) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      n++;
    }
    if (!n) return 0x808080;
    return ((r / n) << 16) | ((g / n) << 8) | (b / n) | 0;
  });

  return {
    texture,
    layerCount: count,
    tileData: (layer: number) => previews[layer] ?? previews[0],
    tileAverage: (layer: number) => averages[layer] ?? 0x808080,
  };
}
