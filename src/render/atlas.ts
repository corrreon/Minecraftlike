/**
 * Génération procédurale de l'atlas de textures.
 *
 * Le jeu n'embarque aucune image : chaque tuile 32×32 est peinte au démarrage
 * dans un `DataArrayTexture`, ce qui supprime tout saignement d'atlas et
 * autorise le mip-mapping propre par couche.
 *
 * Chaque peintre produit en même temps un **champ de hauteur**, d'où l'on
 * dérive une carte de normales tangentes (plus une rugosité par matériau,
 * rangée dans le canal alpha). C'est ce relief par pixel qui fait ressortir le
 * mortier, les rainures des planches ou les cristaux de minerai sous la
 * lumière rasante.
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

export const TILE = 32;
/** Les motifs figuratifs sont dessinés sur une grille 16 puis agrandis. */
const S = TILE / 16;
const STRIDE = TILE * TILE * 4;

type RGB = [number, number, number];

const rgb = (hex: number): RGB => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

class Tile {
  readonly data = new Uint8Array(STRIDE);
  /** Relief, dans [0,1]. Rempli automatiquement depuis la luminance si nul. */
  readonly height = new Float32Array(TILE * TILE);
  private heightWritten = false;

  set(x: number, y: number, c: RGB, a = 255, mul = 1): void {
    const i = (y * TILE + x) * 4;
    this.data[i] = clamp255(c[0] * mul);
    this.data[i + 1] = clamp255(c[1] * mul);
    this.data[i + 2] = clamp255(c[2] * mul);
    this.data[i + 3] = a;
  }

  /** Écrit un « gros pixel » S×S, pour les motifs pensés en 16×16. */
  px(x: number, y: number, c: RGB, a = 255, mul = 1): void {
    for (let dy = 0; dy < S; dy++) {
      for (let dx = 0; dx < S; dx++) {
        const xx = x * S + dx;
        const yy = y * S + dy;
        if (xx < TILE && yy < TILE) this.set(xx, yy, c, a, mul);
      }
    }
  }

  setHeight(x: number, y: number, h: number): void {
    this.height[y * TILE + x] = h;
    this.heightWritten = true;
  }

  /** Creuse le relief sur un « gros pixel ». */
  pxHeight(x: number, y: number, h: number): void {
    for (let dy = 0; dy < S; dy++)
      for (let dx = 0; dx < S; dx++) {
        const xx = x * S + dx, yy = y * S + dy;
        if (xx < TILE && yy < TILE) this.setHeight(xx, yy, h);
      }
  }

  clear(): void {
    this.data.fill(0);
  }

  mul(x: number, y: number, f: number): void {
    const i = (y * TILE + x) * 4;
    this.data[i] = clamp255(this.data[i] * f);
    this.data[i + 1] = clamp255(this.data[i + 1] * f);
    this.data[i + 2] = clamp255(this.data[i + 2] * f);
  }

  /** Assombrit une bande horizontale exprimée en grille 16. */
  darkenRow16(y: number, f: number): void {
    for (let dy = 0; dy < S; dy++) {
      const yy = y * S + dy;
      if (yy >= TILE) continue;
      for (let x = 0; x < TILE; x++) this.mul(x, yy, f);
    }
  }

  /**
   * Complète le champ de hauteur à partir de la luminance quand le peintre ne
   * l'a pas décrit : sur des textures procédurales, sombre = creux est une
   * approximation qui tient remarquablement bien.
   */
  finalizeHeight(): void {
    if (this.heightWritten) return;
    for (let i = 0; i < this.height.length; i++) {
      const j = i * 4;
      const lum = (this.data[j] * 0.299 + this.data[j + 1] * 0.587 + this.data[j + 2] * 0.114) / 255;
      this.height[i] = lum;
    }
  }
}

// ---------------------------------------------------------------------------
// Bruits bouclables
// ---------------------------------------------------------------------------

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

function fbmTile(rnd: () => number, octaves = 4): Float32Array {
  const out = new Float32Array(TILE * TILE);
  let amp = 1, norm = 0, cells = 2;
  for (let o = 0; o < octaves; o++) {
    const n = tileNoise(cells, rnd);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    norm += amp;
    amp *= 0.5;
    cells = Math.min(cells * 2, TILE);
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// ---------------------------------------------------------------------------
// Briques élémentaires de dessin
// ---------------------------------------------------------------------------

function grainy(t: Tile, base: RGB, rnd: () => number, amount = 0.22, octaves = 4): void {
  const n = fbmTile(rnd, octaves);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const f = 1 - amount * 0.5 + n[y * TILE + x] * amount;
      t.set(x, y, base, 255, f);
    }
  }
}

function blotch(t: Tile, color: RGB, rnd: () => number, threshold: number, cells = 5, jitter = 0.12): void {
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
    if (rnd() < 0.5) t.set((x + 1) % TILE, y, color, 255, dark);
  }
}

/**
 * Fissures : marches aléatoires sombres qui creusent le relief. C'est ce qui
 * distingue une vraie pierre d'un simple champ de bruit.
 */
function cracks(t: Tile, rnd: () => number, count: number, len: number, depth = 0.55): void {
  for (let i = 0; i < count; i++) {
    let x = rnd() * TILE;
    let y = rnd() * TILE;
    let a = rnd() * Math.PI * 2;
    for (let k = 0; k < len; k++) {
      a += (rnd() - 0.5) * 0.9;
      x = (x + Math.cos(a) + TILE) % TILE;
      y = (y + Math.sin(a) + TILE) % TILE;
      const xi = x | 0, yi = y | 0;
      t.mul(xi, yi, depth + 0.2);
      t.setHeight(xi, yi, depth * 0.35);
    }
  }
}

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
        // Distance torique : le motif se raccorde d'une tuile à l'autre.
        let dx = Math.abs(px[i] - x - 0.5);
        let dy = Math.abs(py[i] - y - 0.5);
        if (dx > TILE / 2) dx = TILE - dx;
        if (dy > TILE / 2) dy = TILE - dy;
        const d = dx * dx + dy * dy;
        if (d < d0) { d1 = d0; d0 = d; best = i; }
        else if (d < d1) d1 = d;
      }
      const border = Math.sqrt(d1) - Math.sqrt(d0);
      // Joint creusé, galet bombé.
      const inJoint = border < edge;
      const f = inJoint ? 0.5 : pv[best];
      t.set(x, y, base, 255, f);
      t.setHeight(x, y, inJoint ? 0.12 : 0.55 + Math.min(0.45, border * 0.16));
    }
  }
}

/** Planches ou billes de bois : bandes, rainures creusées, veines et nœuds. */
function planks(t: Tile, base: RGB, rnd: () => number, period: number, vertical: boolean): void {
  const n = fbmTile(rnd, 4);
  const veins = fbmTile(rnd, 3);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const axis = vertical ? x : y;
      const along = vertical ? y : x;
      const inBand = axis % period;
      let f = 0.93 + n[y * TILE + x] * 0.16;
      let h = 0.62 + n[y * TILE + x] * 0.2;
      // Rainure entre deux planches : deux pixels, dont un plus sombre.
      if (inBand === 0) { f *= 0.6; h = 0.06; }
      else if (inBand === 1) { f *= 0.82; h = 0.3; }
      // Veinage dans le sens de la fibre.
      const grain = veins[(along % TILE) * TILE + ((axis * 5) % TILE)];
      if (grain > 0.66) { f *= 0.88; h -= 0.12; }
      t.set(x, y, base, 255, f);
      t.setHeight(x, y, Math.max(0, h));
    }
  }
  // Nœuds.
  const knots = 1 + ((rnd() * 2) | 0);
  for (let k = 0; k < knots; k++) {
    const cx = rnd() * TILE, cy = rnd() * TILE, r = 1.6 + rnd() * 1.6;
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        let dx = Math.abs(x - cx), dy = Math.abs(y - cy);
        if (dx > TILE / 2) dx = TILE - dx;
        if (dy > TILE / 2) dy = TILE - dy;
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const f = 0.62 + 0.2 * (d / r);
        t.set(x, y, base, 255, f);
        t.setHeight(x, y, 0.3 + 0.25 * (d / r));
      }
  }
}

function brickPattern(t: Tile, base: RGB, mortar: RGB, rnd: () => number, brickH = 8, brickW = 16): void {
  const n = fbmTile(rnd, 3);
  const joint = Math.max(1, Math.round(S));
  for (let y = 0; y < TILE; y++) {
    const row = Math.floor(y / brickH);
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let x = 0; x < TILE; x++) {
      const isMortar = y % brickH < joint || (x + offset) % brickW < joint;
      const v = n[y * TILE + x];
      t.set(x, y, isMortar ? mortar : base, 255, 0.9 + v * 0.24);
      // Le mortier est en retrait, la brique légèrement bombée.
      t.setHeight(x, y, isMortar ? 0.14 : 0.66 + v * 0.3);
    }
  }
}

function ringPattern(t: Tile, base: RGB, ring: RGB, rnd: () => number): void {
  const n = fbmTile(rnd, 3);
  const c = TILE / 2 - 0.5;
  const spacing = 2.4 * S;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = Math.hypot(x - c, y - c) + n[y * TILE + x] * 2.2;
      const phase = (d % spacing) / spacing;
      const onRing = phase < 0.34;
      t.set(x, y, onRing ? ring : base, 255, 0.9 + n[y * TILE + x] * 0.22);
      t.setHeight(x, y, onRing ? 0.34 : 0.66 + n[y * TILE + x] * 0.2);
    }
  }
}

/** Silhouette de plante : tiges verticales bruitées sur fond transparent. */
function plant(t: Tile, stem: RGB, rnd: () => number, blades: number, height: number): void {
  t.clear();
  for (let i = 0; i < blades; i++) {
    let x = 1 + ((rnd() * (TILE - 2)) | 0);
    const h = height * S * (0.6 + rnd() * 0.4);
    const dir = rnd() < 0.5 ? -1 : 1;
    const w = rnd() < 0.5 ? 1 : Math.max(1, S - 1);
    for (let k = 0; k < h; k++) {
      const y = TILE - 1 - k;
      if (y < 0) break;
      if (k > h * 0.45 && rnd() < 0.22) x += dir;
      if (x < 0 || x >= TILE) break;
      const f = 0.68 + (k / h) * 0.55;
      for (let d = 0; d < w; d++) if (x + d < TILE) t.set(x + d, y, stem, 255, f * (d ? 0.86 : 1));
    }
  }
}

function flower(t: Tile, stem: RGB, petal: RGB, centerC: RGB, rnd: () => number): void {
  t.clear();
  const cx = 7 + ((rnd() * 2) | 0);
  for (let y = 8; y < 16; y++) t.px(cx, y, stem, 255, 0.8 + rnd() * 0.3);
  t.px(cx - 1, 11, stem, 255, 0.72);
  t.px(cx + 1, 13, stem, 255, 0.72);
  const cy = 5;
  const pts: [number, number][] = [
    [0, -2], [0, -1], [-1, -1], [1, -1], [-2, 0], [-1, 0], [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2],
  ];
  for (const [dx, dy] of pts) t.px(cx + dx, cy + dy, petal, 255, 0.85 + rnd() * 0.3);
  t.px(cx, cy, centerC, 255);
}

/**
 * Feuillage : masse de folioles trouée. La fréquence haute domine, sinon on
 * obtient des nuages compacts au lieu d'un branchage aéré.
 */
function leaves(t: Tile, r: () => number, base: number): void {
  const coarse = tileNoise(6, r);
  const fine = tileNoise(14, r);
  const grain = tileNoise(TILE / 2, r);
  const c = rgb(base);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const i = y * TILE + x;
      const v = coarse[i] * 0.45 + fine[i] * 0.55;
      if (v < 0.42) {
        t.set(x, y, c, 0);
        t.setHeight(x, y, 0);
        continue;
      }
      // Nervures sombres et éclats clairs : la masse cesse d'être uniforme.
      // La plage reste sous 1 pour que le feuillage tire vers le vert profond
      // plutôt que vers le vert acide.
      let f = 0.40 + v * 0.62;
      if (grain[i] < 0.3) f *= 0.62;
      else if (grain[i] > 0.78) f *= 1.16;
      t.set(x, y, c, 255, f);
      t.setHeight(x, y, 0.3 + v * 0.65);
    }
  }
}

/** Pierre + amas de minerai cristallins, en relief saillant. */
function oreTile(t: Tile, r: () => number, ore: number): void {
  stoneBase(t, r, 0x7f7f7f);
  const n = tileNoise(5, r);
  const c = rgb(ore);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const v = n[y * TILE + x];
      if (v > 0.70) {
        t.set(x, y, c, 255, 0.85 + v * 0.4);
        t.setHeight(x, y, 0.9);
      } else if (v > 0.63) {
        t.set(x, y, c, 255, 0.55);
        t.setHeight(x, y, 0.72);
      }
    }
  }
}

function stoneBase(t: Tile, r: () => number, base: number): void {
  grainy(t, rgb(base), r, 0.26, 5);
  speckle(t, rgb(base), r, 26, 0.82);
  cracks(t, r, 3, 22, 0.6);
}

function metalTile(t: Tile, r: () => number, base: number): void {
  grainy(t, rgb(base), r, 0.1, 3);
  // Biseau : clair en haut à gauche, sombre en bas à droite.
  const b = Math.max(1, Math.round(S));
  for (let i = 0; i < TILE; i++) {
    for (let k = 0; k < b; k++) {
      t.mul(i, k, 1.14);
      t.mul(k, i, 1.1);
      t.mul(i, TILE - 1 - k, 0.84);
      t.mul(TILE - 1 - k, i, 0.87);
      t.setHeight(i, k, 0.9);
      t.setHeight(k, i, 0.88);
      t.setHeight(i, TILE - 1 - k, 0.3);
      t.setHeight(TILE - 1 - k, i, 0.32);
    }
  }
  for (let y = b; y < TILE - b; y++) for (let x = b; x < TILE - b; x++) t.setHeight(x, y, 0.66);
}

function mushroom(t: Tile, r: () => number, cap: number, spot: number): void {
  t.clear();
  for (let y = 9; y < 16; y++) {
    t.px(7, y, rgb(0xe0d8c0), 255, 0.85 + r() * 0.2);
    t.px(8, y, rgb(0xc8bfa4), 255);
  }
  for (let y = 4; y < 10; y++) {
    const w = y < 6 ? 3 : y < 8 ? 5 : 4;
    for (let x = 8 - w; x <= 7 + w; x++) {
      if (x < 0 || x >= 16) continue;
      t.px(x, y, rgb(cap), 255, 0.85 + r() * 0.3);
    }
  }
  for (let i = 0; i < 4; i++) t.px(4 + ((r() * 8) | 0), 5 + ((r() * 4) | 0), rgb(spot), 255);
}

function sapling(t: Tile, r: () => number): void {
  t.clear();
  for (let y = 10; y < 16; y++) t.px(7, y, rgb(0x6b4a2a), 255, 0.9);
  const pts: [number, number][] = [[7, 4], [6, 5], [8, 5], [5, 6], [7, 6], [9, 6], [6, 7], [8, 7], [7, 8], [5, 8], [9, 8], [7, 9]];
  for (const [x, y] of pts) t.px(x, y, rgb(0xffffff), 255, 0.75 + r() * 0.4);
}

// ---------------------------------------------------------------------------
// Peintres par nom de texture
// ---------------------------------------------------------------------------

const PAINTERS: Record<string, (t: Tile, rnd: () => number) => void> = {
  air: (t) => t.clear(),
  missing: (t) => {
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++)
        t.set(x, y, (x >> 4) % 2 === (y >> 4) % 2 ? [0, 0, 0] : [248, 0, 248]);
  },

  stone: (t, r) => stoneBase(t, r, 0x7f7f7f),
  andesite: (t, r) => { grainy(t, rgb(0x898b89), r, 0.2, 5); speckle(t, rgb(0x74766f), r, 34, 0.9); cracks(t, r, 2, 16); },
  granite: (t, r) => { grainy(t, rgb(0x9a6b5c), r, 0.22, 5); speckle(t, rgb(0xb08b7b), r, 40, 1.1); speckle(t, rgb(0x6f4a3c), r, 16, 0.85); },
  diorite: (t, r) => { grainy(t, rgb(0xcfcfcf), r, 0.2, 5); speckle(t, rgb(0xa0a0a0), r, 40, 0.9); speckle(t, rgb(0xf0f0f0), r, 14, 1.05); },
  cobblestone: (t, r) => { cellular(t, rgb(0x7d7d7d), r, 11, 1.1, 0.36); speckle(t, rgb(0x616161), r, 18, 0.9); },
  mossy_cobblestone: (t, r) => { cellular(t, rgb(0x7d7d7d), r, 11, 1.1, 0.36); blotch(t, rgb(0x51702f), r, 0.54, 5, 0.2); },
  stone_bricks: (t, r) => brickPattern(t, rgb(0x7b7b7b), rgb(0x5a5a5a), r, 16, 32),
  bricks: (t, r) => brickPattern(t, rgb(0x9a5b48), rgb(0xb9ada6), r, 8, 16),
  bedrock: (t, r) => { cellular(t, rgb(0x565656), r, 16, 0.9, 0.6); speckle(t, rgb(0x2a2a2a), r, 44, 0.7); },
  obsidian: (t, r) => { grainy(t, rgb(0x14101f), r, 0.5, 4); speckle(t, rgb(0x4a3a72), r, 20, 1.4); cracks(t, r, 4, 18, 0.7); },

  dirt: (t, r) => { grainy(t, rgb(0x866043), r, 0.3, 5); speckle(t, rgb(0x6b4a31), r, 40, 0.85); speckle(t, rgb(0x9a7550), r, 18, 1.1); },
  coarse_dirt: (t, r) => { grainy(t, rgb(0x77543a), r, 0.36, 5); speckle(t, rgb(0x5d4029), r, 54, 0.8); },
  grass_top: (t, r) => { grainy(t, rgb(0xe6e6e6), r, 0.26, 5); speckle(t, rgb(0xc2c2c2), r, 34, 0.92); },
  grass_side: (t, r) => {
    grainy(t, rgb(0x866043), r, 0.3, 5);
    speckle(t, rgb(0x6b4a31), r, 30, 0.85);
    // Frange d'herbe dentelée retombant sur la terre, sur un quart du bloc.
    const n = tileNoise(10, r);
    const fine = tileNoise(TILE, r);
    for (let x = 0; x < TILE; x++) {
      const h = Math.round(2.2 * S + n[x] * 2.6 * S + (fine[x] > 0.7 ? S : 0));
      for (let y = 0; y < h; y++) {
        t.set(x, y, rgb(0xe6e6e6), 255, 0.84 + fine[y * TILE + x] * 0.28);
        t.setHeight(x, y, 0.75);
      }
    }
  },
  sand: (t, r) => { grainy(t, rgb(0xdcd0a0), r, 0.14, 5); speckle(t, rgb(0xc9bb87), r, 40, 0.95); speckle(t, rgb(0xefe6c0), r, 18, 1.05); },
  red_sand: (t, r) => { grainy(t, rgb(0xbe6c31), r, 0.16, 5); speckle(t, rgb(0xa85a26), r, 36, 0.95); },
  gravel: (t, r) => { cellular(t, rgb(0x847e7c), r, 22, 0.8, 0.55); speckle(t, rgb(0x5b5654), r, 24, 0.85); },
  clay: (t, r) => grainy(t, rgb(0xa0a5b3), r, 0.12, 4),
  snow: (t, r) => { grainy(t, rgb(0xf3f8f8), r, 0.07, 4); speckle(t, rgb(0xffffff), r, 20, 1.03); },

  sandstone: (t, r) => {
    grainy(t, rgb(0xd9cca3), r, 0.12, 4);
    // Strates sédimentaires.
    for (const y of [0, 5, 11]) t.darkenRow16(y, y === 0 ? 0.8 : 0.92);
    for (let x = 0; x < TILE; x++) {
      for (const y of [0, 5, 11]) {
        for (let k = 0; k < S; k++) t.setHeight(x, y * S + k, 0.25);
      }
    }
  },
  sandstone_top: (t, r) => grainy(t, rgb(0xe0d3ac), r, 0.1, 5),
  sandstone_bottom: (t, r) => grainy(t, rgb(0xc7b98f), r, 0.14, 5),

  water: (t, r) => {
    const n = fbmTile(r, 4);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        t.set(x, y, rgb(0x3a6fd8), 205, 0.85 + n[y * TILE + x] * 0.35);
        t.setHeight(x, y, 0.5);
      }
  },
  ice: (t, r) => {
    const n = fbmTile(r, 4);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        t.set(x, y, rgb(0xa5cdf5), 190, 0.88 + n[y * TILE + x] * 0.28);
        t.setHeight(x, y, 0.5);
      }
    cracks(t, r, 3, 16, 0.85);
  },
  packed_ice: (t, r) => grainy(t, rgb(0x8fbdf0), r, 0.14, 4),
  lava: (t, r) => {
    const n = fbmTile(r, 4);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const v = n[y * TILE + x];
        t.set(x, y, v > 0.62 ? rgb(0xffd23a) : v > 0.42 ? rgb(0xef7215) : rgb(0xc63d05), 255, 0.9 + v * 0.3);
        t.setHeight(x, y, 0.4 + v * 0.4);
      }
  },

  glass: (t, r) => {
    t.clear();
    const b = Math.max(1, Math.round(S));
    for (let i = 0; i < TILE; i++) {
      for (let k = 0; k < b; k++) {
        t.set(i, k, rgb(0xd6f2ff), 200);
        t.set(i, TILE - 1 - k, rgb(0xd6f2ff), 200);
        t.set(k, i, rgb(0xd6f2ff), 200);
        t.set(TILE - 1 - k, i, rgb(0xd6f2ff), 200);
      }
    }
    // Reflets diagonaux.
    for (let i = 0; i < 6; i++) {
      const x = 3 + ((r() * (TILE - 8)) | 0);
      const y = 3 + ((r() * (TILE - 8)) | 0);
      for (let k = 0; k < 3; k++) t.set(x + k, y + k, rgb(0xffffff), 110 - k * 26);
    }
  },

  oak_planks: (t, r) => planks(t, rgb(0xb08a55), r, 8, false),
  birch_planks: (t, r) => planks(t, rgb(0xd7cb8d), r, 8, false),
  spruce_planks: (t, r) => planks(t, rgb(0x7a5b36), r, 8, false),
  jungle_planks: (t, r) => planks(t, rgb(0xb17f5f), r, 8, false),
  oak_log: (t, r) => planks(t, rgb(0x6b5231), r, 10, true),
  birch_log: (t, r) => {
    planks(t, rgb(0xd8d6cf), r, 12, true);
    // Lenticelles caractéristiques du bouleau.
    for (let i = 0; i < 6; i++) {
      const x = (r() * (TILE - 6)) | 0, y = (r() * TILE) | 0;
      const w = 3 + ((r() * 4) | 0);
      for (let k = 0; k < w; k++) { t.set(x + k, y, rgb(0x33322c)); t.setHeight(x + k, y, 0.25); }
    }
  },
  spruce_log: (t, r) => planks(t, rgb(0x4c3a22), r, 10, true),
  jungle_log: (t, r) => planks(t, rgb(0x584220), r, 10, true),
  oak_log_top: (t, r) => ringPattern(t, rgb(0xa0813f), rgb(0x8a6b32), r),
  birch_log_top: (t, r) => ringPattern(t, rgb(0xd7cb8d), rgb(0xbcb078), r),
  spruce_log_top: (t, r) => ringPattern(t, rgb(0x7a5b36), rgb(0x62492b), r),
  jungle_log_top: (t, r) => ringPattern(t, rgb(0xb17f5f), rgb(0x94674a), r),
  bookshelf: (t, r) => {
    planks(t, rgb(0xb08a55), r, 16, false);
    const colors = [rgb(0xa63b2c), rgb(0x3b6ea6), rgb(0xd0b64c), rgb(0x4a8a3f), rgb(0x8a4aa1), rgb(0x2f7a70)];
    for (const rowY of [2, 10]) {
      let x = 0;
      while (x < 16) {
        const w = 1 + ((r() * 2) | 0);
        const c = colors[(r() * colors.length) | 0];
        for (let dx = 0; dx < w && x + dx < 16; dx++)
          for (let dy = 0; dy < 5; dy++) {
            t.px(x + dx, rowY + dy, c, 255, 0.8 + r() * 0.35);
            t.pxHeight(x + dx, rowY + dy, 0.8);
          }
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

  coal_block: (t, r) => { grainy(t, rgb(0x1a1a1a), r, 0.35, 5); speckle(t, rgb(0x3a3a3a), r, 26, 1.3); cracks(t, r, 3, 14, 0.6); },
  iron_block: (t, r) => metalTile(t, r, 0xd8d8d8),
  gold_block: (t, r) => metalTile(t, r, 0xf7d84c),
  diamond_block: (t, r) => metalTile(t, r, 0x62e8e0),
  emerald_block: (t, r) => metalTile(t, r, 0x3ddb6a),
  lapis_block: (t, r) => { grainy(t, rgb(0x2a55c6), r, 0.28, 5); speckle(t, rgb(0x18378c), r, 30, 0.85); speckle(t, rgb(0x5c86ea), r, 14, 1.15); },
  redstone_block: (t, r) => { grainy(t, rgb(0xb31d1d), r, 0.3, 5); speckle(t, rgb(0x7d1010), r, 34, 0.85); },

  glowstone: (t, r) => { grainy(t, rgb(0xd6a441), r, 0.22, 4); blotch(t, rgb(0xffe9a8), r, 0.58, 4, 0.2); },
  sea_lantern: (t, r) => { grainy(t, rgb(0xb9e3dc), r, 0.16, 4); blotch(t, rgb(0xeafffb), r, 0.55, 4); },

  crafting_top: (t, r) => {
    planks(t, rgb(0xb08a55), r, 8, false);
    for (let i = 0; i < TILE; i++) {
      for (const g of [5, 10]) {
        for (let k = 0; k < S; k++) {
          t.mul(i, g * S + k, 0.6);
          t.mul(g * S + k, i, 0.6);
          t.setHeight(i, g * S + k, 0.15);
          t.setHeight(g * S + k, i, 0.15);
        }
      }
    }
  },
  crafting_side: (t, r) => {
    planks(t, rgb(0x9c7a4a), r, 8, false);
    for (let x = 3; x < 13; x++) { t.px(x, 4, rgb(0x6a5030), 255); t.px(x, 11, rgb(0x6a5030), 255); }
    for (let y = 4; y < 12; y++) { t.px(3, y, rgb(0x6a5030), 255); t.px(12, y, rgb(0x6a5030), 255); }
  },
  furnace_top: (t, r) => cellular(t, rgb(0x707070), r, 9, 0.9, 0.25),
  furnace_front: (t, r) => {
    cellular(t, rgb(0x707070), r, 9, 0.9, 0.25);
    for (let y = 6; y < 13; y++)
      for (let x = 4; x < 12; x++) { t.px(x, y, rgb(0x2a2a2a), 255, 0.9 + r() * 0.2); t.pxHeight(x, y, 0.1); }
    for (let x = 5; x < 11; x++) t.px(x, 12, rgb(0x5a5a5a), 255);
  },
  // Porte : deux tuiles empilées. Le battant est cerné d'un dormant sombre, la
  // moitié haute reçoit une fenêtre à petits carreaux, la basse la poignée.
  door_lower: (t, r) => {
    planks(t, rgb(0xa9814d), r, 6, true);
    for (let y = 0; y < 16; y++) { t.px(0, y, rgb(0x6d5028), 255); t.px(15, y, rgb(0x6d5028), 255); }
    for (let x = 0; x < 16; x++) t.px(x, 15, rgb(0x6d5028), 255);
    for (let x = 2; x < 14; x++) { t.px(x, 2, rgb(0x8a6a3c), 255); t.px(x, 13, rgb(0x8a6a3c), 255); }
    for (let y = 2; y < 14; y++) { t.px(2, y, rgb(0x8a6a3c), 255); t.px(13, y, rgb(0x8a6a3c), 255); }
    // Poignée : un bouton clair, creusé dans le relief pour attraper la lumière.
    for (const [hx, hy] of [[12, 8], [12, 9]] as const) { t.px(hx, hy, rgb(0xd9c479), 255); t.pxHeight(hx, hy, 1); }
  },
  door_upper: (t, r) => {
    planks(t, rgb(0xa9814d), r, 6, true);
    for (let y = 0; y < 16; y++) { t.px(0, y, rgb(0x6d5028), 255); t.px(15, y, rgb(0x6d5028), 255); }
    for (let x = 0; x < 16; x++) t.px(x, 0, rgb(0x6d5028), 255);
    for (let y = 3; y < 9; y++)
      for (let x = 3; x < 13; x++) { t.px(x, y, rgb(0x9fd4e8), 190, 0.9 + r() * 0.2); t.pxHeight(x, y, 0.1); }
    // Croisillon de la fenêtre.
    for (let y = 3; y < 9; y++) { t.px(7, y, rgb(0x6d5028), 255); t.pxHeight(7, y, 0.7); }
    for (let x = 3; x < 13; x++) { t.px(x, 5, rgb(0x6d5028), 255); t.pxHeight(x, 5, 0.7); }
  },

  // Échelle : deux montants et des barreaux, le reste transparent — c'est ce
  // vide qui la distingue d'une planche vue de loin.
  ladder: (t, r) => {
    t.clear();
    const bois = rgb(0x9a7440);
    const ombre = rgb(0x6d5028);
    for (let y = 0; y < 16; y++) {
      for (const x of [2, 3, 12, 13]) {
        t.px(x, y, x === 3 || x === 13 ? ombre : bois, 255, 0.9 + r() * 0.2);
        t.pxHeight(x, y, 0.85);
      }
    }
    // Barreaux, un tous les quatre pixels : de loin on lit l'échelle à son pas.
    for (const y of [1, 5, 9, 13]) {
      for (let x = 3; x < 13; x++) {
        t.px(x, y, bois, 255, 0.85 + r() * 0.2);
        t.pxHeight(x, y, 0.6);
      }
    }
  },

  // Lit : la tuile du dessus tourne avec l'orientation du bloc, l'oreiller est
  // donc toujours dessiné du même côté — celui de la tête.
  bed_head: (t, r) => {
    grainy(t, rgb(0xa62b2b), r, 0.16, 4);
    for (let y = 12; y < 16; y++)
      for (let x = 1; x < 15; x++) { t.px(x, y, rgb(0xe8e4dc), 255, 0.92 + r() * 0.16); t.pxHeight(x, y, 0.9); }
    for (let x = 1; x < 15; x++) t.px(x, 11, rgb(0x7d1f1f), 255);
  },
  bed_foot: (t, r) => {
    grainy(t, rgb(0xa62b2b), r, 0.16, 4);
    // Pli du drap, replié sur le pied du lit.
    for (let x = 1; x < 15; x++) { t.px(x, 3, rgb(0x8d2323), 255); t.pxHeight(x, 3, 0.35); }
  },
  bed_side: (t, r) => {
    grainy(t, rgb(0x9c2828), r, 0.16, 4);
    // Sommier de bois sous le matelas.
    for (let y = 12; y < 16; y++)
      for (let x = 0; x < 16; x++) { t.px(x, y, rgb(0x8a6438), 255, 0.9 + r() * 0.2); t.pxHeight(x, y, 0.4); }
  },

  chest_top: (t, r) => planks(t, rgb(0x9a6a34), r, 10, false),
  chest_side: (t, r) => {
    planks(t, rgb(0x8a5c2c), r, 12, false);
    for (let x = 0; x < 16; x++) { t.px(x, 6, rgb(0x4a3118), 255); t.pxHeight(x, 6, 0.12); }
    for (let y = 4; y < 9; y++) { t.px(7, y, rgb(0x3a3128)); t.px(8, y, rgb(0x2a2a2a)); }
    t.px(7, 6, rgb(0xd8c264));
    t.px(8, 6, rgb(0xb89a44));
  },
  tnt_top: (t, r) => { grainy(t, rgb(0xb03b2c), r, 0.18, 4); t.darkenRow16(0, 0.7); },
  tnt_bottom: (t, r) => grainy(t, rgb(0x6b4a35), r, 0.18, 4),
  tnt_side: (t, r) => {
    grainy(t, rgb(0xb03b2c), r, 0.18, 4);
    for (let y = 5; y < 11; y++) for (let x = 0; x < 16; x++) t.px(x, y, rgb(0xf0f0f0), 255, 0.9 + r() * 0.2);
    for (let x = 2; x < 14; x++) { t.px(x, 7, rgb(0x1a1a1a)); t.px(x, 8, rgb(0x1a1a1a)); }
  },
  pumpkin_top: (t, r) => {
    grainy(t, rgb(0xc47418), r, 0.2, 4);
    for (let i = 0; i < 4; i++) t.px(7 + (i % 2), 7 + ((i / 2) | 0), rgb(0x6f5a22));
  },
  pumpkin_side: (t, r) => {
    grainy(t, rgb(0xd2801c), r, 0.16, 4);
    // Côtes verticales.
    for (let x = 0; x < TILE; x += 4 * S)
      for (let y = 0; y < TILE; y++) { t.mul(x, y, 0.76); t.setHeight(x, y, 0.2); }
  },
  jack_o_lantern: (t, r) => {
    grainy(t, rgb(0xd2801c), r, 0.16, 4);
    for (let x = 0; x < TILE; x += 4 * S) for (let y = 0; y < TILE; y++) t.mul(x, y, 0.76);
    const face: [number, number][] = [
      [4, 5], [5, 5], [4, 6], [10, 5], [11, 5], [11, 6],
      [4, 10], [5, 11], [6, 11], [7, 10], [8, 11], [9, 11], [10, 10], [11, 10],
    ];
    for (const [x, y] of face) t.px(x, y, rgb(0xffe27a));
  },
  melon_top: (t, r) => grainy(t, rgb(0x6f9b32), r, 0.2, 4),
  melon_side: (t, r) => {
    grainy(t, rgb(0x6f9b32), r, 0.22, 4);
    const n = fbmTile(r, 4);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (n[y * TILE + x] > 0.6) t.set(x, y, rgb(0x9bc255), 255, 0.9);
  },

  cactus_top: (t, r) => { grainy(t, rgb(0x577d2e), r, 0.16, 4); speckle(t, rgb(0xd8e3b0), r, 10, 1.2); },
  cactus_bottom: (t, r) => grainy(t, rgb(0x6b5a3a), r, 0.16, 4),
  cactus_side: (t, r) => {
    grainy(t, rgb(0x4f7a2a), r, 0.14, 4);
    for (let y = 0; y < TILE; y++) for (let k = 0; k < S; k++) { t.mul(k, y, 0.68); t.mul(TILE - 1 - k, y, 0.68); }
    for (let y = 1; y < 16; y += 4) { t.px(4, y, rgb(0xdfe8c0), 255); t.px(11, y + 2, rgb(0xdfe8c0), 255); }
  },

  wool: (t, r) => {
    grainy(t, rgb(0xffffff), r, 0.12, 5);
    // Trame tissée : deux directions alternées.
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const weave = ((x >> 1) + (y >> 1)) % 2 === 0 ? 1.03 : 0.95;
        t.mul(x, y, weave);
        t.setHeight(x, y, weave > 1 ? 0.62 : 0.42);
      }
  },

  tall_grass: (t, r) => plant(t, rgb(0xffffff), r, 9, 13),
  fern: (t, r) => plant(t, rgb(0xffffff), r, 7, 11),
  wheat: (t, r) => plant(t, rgb(0xd8c25a), r, 8, 13),
  sugar_cane: (t, r) => plant(t, rgb(0xffffff), r, 5, 16),
  dead_bush: (t, r) => plant(t, rgb(0x8a6b33), r, 8, 10),
  dandelion: (t, r) => flower(t, rgb(0x4c8a32), rgb(0xf4d63b), rgb(0xfff3a0), r),
  poppy: (t, r) => flower(t, rgb(0x4c8a32), rgb(0xd23b2c), rgb(0x2a2a2a), r),
  blue_orchid: (t, r) => flower(t, rgb(0x4c8a32), rgb(0x2fa9e0), rgb(0xf0f8ff), r),
  brown_mushroom: (t, r) => mushroom(t, r, 0x9b7050, 0xc8a887),
  red_mushroom: (t, r) => mushroom(t, r, 0xd23b2c, 0xf0f0f0),
  oak_sapling: (t, r) => sapling(t, r),
  birch_sapling: (t, r) => sapling(t, r),
  spruce_sapling: (t, r) => sapling(t, r),
  jungle_sapling: (t, r) => sapling(t, r),
  // --- Palette « créatif » -------------------------------------------------
  // Béton, terre cuite et verre teinté sont peints en gris neutre : la teinte
  // du bloc les colore à l'affichage, ce qui évite 48 textures redondantes.
  concrete: (t, r) => { grainy(t, rgb(0xffffff), r, 0.07, 4); speckle(t, rgb(0xf0f0f0), r, 18, 0.97); },
  terracotta: (t, r) => {
    grainy(t, rgb(0xffffff), r, 0.16, 4);
    const n = tileNoise(5, r);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) if (n[y * TILE + x] > 0.62) t.mul(x, y, 0.86);
    speckle(t, rgb(0xd8d8d8), r, 22, 0.9);
  },
  stained_glass: (t, r) => {
    grainy(t, rgb(0xffffff), r, 0.05, 3);
    const b = Math.max(1, Math.round(S));
    for (let i = 0; i < TILE; i++)
      for (let k = 0; k < b; k++) {
        t.set(i, k, rgb(0xffffff), 210, 1.1);
        t.set(i, TILE - 1 - k, rgb(0xffffff), 210, 1.1);
        t.set(k, i, rgb(0xffffff), 210, 1.1);
        t.set(TILE - 1 - k, i, rgb(0xffffff), 210, 1.1);
      }
    for (let y = b; y < TILE - b; y++) for (let x = b; x < TILE - b; x++) t.data[(y * TILE + x) * 4 + 3] = 130;
  },

  smooth_stone: (t, r) => grainy(t, rgb(0xa0a0a0), r, 0.06, 4),
  polished_granite: (t, r) => { grainy(t, rgb(0x9a6b5c), r, 0.09, 4); speckle(t, rgb(0xb08b7b), r, 16, 1.06); },
  polished_diorite: (t, r) => { grainy(t, rgb(0xcfcfcf), r, 0.08, 4); speckle(t, rgb(0xb4b4b4), r, 16, 0.96); },
  polished_andesite: (t, r) => { grainy(t, rgb(0x898b89), r, 0.08, 4); speckle(t, rgb(0x9c9e9a), r, 16, 1.05); },
  cracked_stone_bricks: (t, r) => { brickPattern(t, rgb(0x7b7b7b), rgb(0x5a5a5a), r, 16, 32); cracks(t, r, 5, 20, 0.5); },
  chiseled_stone_bricks: (t, r) => {
    grainy(t, rgb(0x777777), r, 0.12, 4);
    const b = Math.max(1, Math.round(S));
    for (let i = 0; i < TILE; i++)
      for (let k = 0; k < b; k++) { t.mul(i, k, 0.7); t.mul(k, i, 0.7); t.mul(i, TILE - 1 - k, 0.7); t.mul(TILE - 1 - k, i, 0.7); }
    // Motif gravé au centre.
    for (let y = 8; y < 16; y++) for (let x = 5; x < 11; x++) t.px(x, y - 4, rgb(0x616161), 255, 0.95 + r() * 0.1);
    for (let y = 5; y < 8; y++) for (let x = 6; x < 10; x++) t.px(x, y, rgb(0x8a8a8a), 255);
  },
  quartz: (t, r) => grainy(t, rgb(0xece8e1), r, 0.07, 4),
  quartz_pillar: (t, r) => {
    grainy(t, rgb(0xece8e1), r, 0.07, 4);
    for (let x = 0; x < TILE; x += 4 * S)
      for (let y = 0; y < TILE; y++) { t.mul(x, y, 0.9); t.setHeight(x, y, 0.3); }
  },
  quartz_pillar_top: (t, r) => { grainy(t, rgb(0xece8e1), r, 0.07, 4); ringPattern(t, rgb(0xece8e1), rgb(0xd8d2c8), r); },
  prismarine: (t, r) => { cellular(t, rgb(0x5f9c92), r, 10, 0.9, 0.24); blotch(t, rgb(0x7ab8ab), r, 0.6, 5); },
  dark_prismarine: (t, r) => { grainy(t, rgb(0x2f4f43), r, 0.16, 5); speckle(t, rgb(0x1f382e), r, 26, 0.9); },
  purpur: (t, r) => { grainy(t, rgb(0xa878a8), r, 0.13, 4); speckle(t, rgb(0xc09ac0), r, 20, 1.06); },
  nether_bricks: (t, r) => brickPattern(t, rgb(0x36191d), rgb(0x221013), r, 8, 16),

  // --- Nether et End -------------------------------------------------------
  netherrack: (t, r) => {
    // Roche fibreuse : des veines sombres au lieu de grains isolés.
    grainy(t, rgb(0x7a2b2f), r, 0.34, 5);
    const n = tileNoise(9, r);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const v = n[y * TILE + x];
        if (v < 0.34) { t.mul(x, y, 0.6); t.setHeight(x, y, 0.25); }
        else if (v > 0.76) { t.mul(x, y, 1.22); t.setHeight(x, y, 0.85); }
      }
    speckle(t, rgb(0x4a1418), r, 30, 0.9);
  },
  soul_sand: (t, r) => {
    grainy(t, rgb(0x574134), r, 0.2, 5);
    // Trois visages en creux, à peine lisibles : c'est ce qui fait le bloc.
    for (const [cx, cy] of [[4, 5], [11, 4], [7, 11]] as const) {
      for (const [dx, dy] of [[0, 0], [2, 0], [0, 2], [1, 3], [2, 2]] as const) {
        t.px(cx + dx - 1, cy + dy - 1, rgb(0x33241c), 255, 0.9);
        t.pxHeight(cx + dx - 1, cy + dy - 1, 0.12);
      }
    }
    speckle(t, rgb(0x6b5342), r, 24, 1.05);
  },
  magma: (t, r) => {
    // Croûte sombre parcourue de fissures incandescentes.
    grainy(t, rgb(0x30170f), r, 0.3, 5);
    const n = fbmTile(r, 4);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const v = n[y * TILE + x];
        if (v > 0.62) {
          const hot = (v - 0.62) / 0.38;
          t.set(x, y, rgb(0xff8a1e), 255, 0.55 + hot * 0.85);
          t.setHeight(x, y, 0.15);
        } else t.setHeight(x, y, 0.8);
      }
  },
  glowing_obsidian: (t, r) => {
    grainy(t, rgb(0x14101f), r, 0.5, 4);
    speckle(t, rgb(0x4a3a72), r, 18, 1.4);
    // Les fissures pleurent une lueur violette.
    for (let i = 0; i < 5; i++) {
      let x = r() * TILE, y = r() * TILE, a = r() * Math.PI * 2;
      for (let k = 0; k < 16; k++) {
        a += (r() - 0.5) * 0.9;
        x = (x + Math.cos(a) + TILE) % TILE;
        y = (y + Math.sin(a) + TILE) % TILE;
        t.set(x | 0, y | 0, rgb(0xb26ce8), 255, 0.9 + r() * 0.4);
        t.setHeight(x | 0, y | 0, 0.2);
      }
    }
  },
  ancient_debris: (t, r) => {
    // Base netherrack, mais le minerai est une croûte métallique, pas des grains.
    grainy(t, rgb(0x4a2a24), r, 0.3, 5);
    const n = tileNoise(4, r);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const v = n[y * TILE + x];
        if (v > 0.58) {
          t.set(x, y, rgb(0x6d5346), 255, 0.8 + v * 0.5);
          t.setHeight(x, y, 0.95);
        }
      }
    speckle(t, rgb(0x8a6f5e), r, 16, 1.1);
  },
  netherite_block: (t, r) => {
    metalTile(t, r, 0x463a3d);
    speckle(t, rgb(0x6b585c), r, 22, 1.15);
    speckle(t, rgb(0x2a2224), r, 18, 0.9);
  },
  nether_quartz_ore: (t, r) => {
    grainy(t, rgb(0x7a2b2f), r, 0.3, 5);
    const n = tileNoise(5, r);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const v = n[y * TILE + x];
        if (v > 0.7) { t.set(x, y, rgb(0xece8e1), 255, 0.85 + v * 0.4); t.setHeight(x, y, 0.9); }
        else if (v > 0.63) { t.set(x, y, rgb(0xece8e1), 255, 0.55); t.setHeight(x, y, 0.72); }
      }
  },
  end_stone: (t, r) => {
    grainy(t, rgb(0xdcdca8), r, 0.12, 4);
    speckle(t, rgb(0xc4c48a), r, 30, 0.94);
    speckle(t, rgb(0xf0f0c8), r, 14, 1.06);
  },
  end_portal_frame: (t, r) => {
    grainy(t, rgb(0x3f6a56), r, 0.12, 4);
    // Assise plus sombre : le cadre se lit comme un socle.
    for (let y = 10; y < 16; y++) for (let x = 0; x < 16; x++) { t.px(x, y, rgb(0x2c4c3d), 255, 0.95 + r() * 0.1); }
  },
  end_portal_frame_top: (t, r) => {
    grainy(t, rgb(0x4a7a63), r, 0.1, 4);
    const b = Math.max(1, Math.round(S));
    for (let i = 0; i < TILE; i++)
      for (let k = 0; k < b; k++) { t.mul(i, k, 0.82); t.mul(k, i, 0.82); t.mul(i, TILE - 1 - k, 0.82); t.mul(TILE - 1 - k, i, 0.82); }
  },
  end_portal_frame_eye: (t, r) => {
    grainy(t, rgb(0x4a7a63), r, 0.1, 4);
    // Œil serti au centre.
    for (let y = 4; y < 12; y++)
      for (let x = 4; x < 12; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        if (d > 4) continue;
        t.px(x, y, d < 1.6 ? rgb(0xf2f0d8) : rgb(0x2a6a52), 255, 0.9 + r() * 0.25);
        t.pxHeight(x, y, 0.95);
      }
  },
  nether_portal: (t, r) => {
    // Voile violet tourbillonnant, semi-transparent.
    const n = fbmTile(r, 4);
    const m = tileNoise(6, r);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const v = n[y * TILE + x] * 0.6 + m[y * TILE + x] * 0.4;
        t.set(x, y, rgb(0x8a3ad8), Math.round(120 + v * 110), 0.5 + v * 1.1);
        t.setHeight(x, y, v);
      }
  },
  end_portal: (t, r) => {
    // Ciel étoilé encastré dans le sol.
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) t.set(x, y, rgb(0x080a18), 235);
    for (let i = 0; i < 44; i++) {
      const x = (r() * TILE) | 0, y = (r() * TILE) | 0;
      const c = r() < 0.3 ? rgb(0xa8c8ff) : r() < 0.6 ? rgb(0xd8b0ff) : rgb(0xffffff);
      t.set(x, y, c, 255, 0.6 + r() * 0.9);
    }
  },

  end_crystal: (t, r) => {
    // Losange facetté, sur fond transparent : le cristal flotte.
    t.clear();
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const dx = Math.abs(x - TILE / 2 + 0.5) / (TILE / 2);
        const dy = Math.abs(y - TILE / 2 + 0.5) / (TILE / 2);
        const d = dx + dy;
        if (d > 0.95) continue;
        // Facettes : la teinte bascule d'un quadrant à l'autre.
        const facet = (x < TILE / 2 ? 1.12 : 0.86) * (y < TILE / 2 ? 1.06 : 0.92);
        const core = d < 0.35 ? 1.5 : 1;
        t.set(x, y, rgb(0xc79cf0), 235, facet * core * (0.7 + r() * 0.2));
        t.setHeight(x, y, 1 - d);
      }
  },
  dragon_egg: (t, r) => {
    grainy(t, rgb(0x120a1c), r, 0.4, 5);
    // Marbrures violettes, comme des veines sous la coquille.
    const n = tileNoise(7, r);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const v = n[y * TILE + x];
        if (v > 0.72) { t.set(x, y, rgb(0x6a3a9a), 255, 0.8 + v * 0.5); t.setHeight(x, y, 0.9); }
        else if (v < 0.25) { t.mul(x, y, 0.6); t.setHeight(x, y, 0.2); }
      }
    speckle(t, rgb(0xa87ad8), r, 12, 1.2);
  },

  torch: (t, r) => {
    t.clear();
    for (let y = 6; y < 16; y++) {
      t.px(7, y, rgb(0x8a6a3a), 255, 0.85 + r() * 0.25);
      t.px(8, y, rgb(0x6d5129), 255);
    }
    t.px(6, 5, rgb(0xd8721a));
    t.px(9, 5, rgb(0xd8721a));
    t.px(7, 5, rgb(0xffc84a));
    t.px(8, 5, rgb(0xffb020));
    t.px(7, 4, rgb(0xfff3c4));
    t.px(8, 4, rgb(0xffe08a));
    t.px(7, 3, rgb(0xfffbe6));
  },
};

// ---------------------------------------------------------------------------
// Propriétés de surface
// ---------------------------------------------------------------------------

/** Amplitude du relief et rugosité, déduites du nom de la texture. */
function surfaceOf(name: string): { relief: number; roughness: number } {
  if (name === 'water') return { relief: 0.15, roughness: 0.05 };
  if (name === 'ice' || name === 'packed_ice') return { relief: 0.25, roughness: 0.12 };
  if (name === 'glass') return { relief: 0, roughness: 0.08 };
  if (name.endsWith('_leaves') || name === 'air') return { relief: 0.35, roughness: 0.9 };
  if (name === 'iron_block' || name === 'gold_block' || name === 'diamond_block' || name === 'emerald_block') {
    return { relief: 0.5, roughness: 0.22 };
  }
  if (name === 'wool') return { relief: 0.6, roughness: 1 };
  if (name === 'lava' || name === 'glowstone' || name === 'sea_lantern') return { relief: 0.4, roughness: 0.75 };
  if (name === 'nether_portal' || name === 'end_portal') return { relief: 0.2, roughness: 0.1 };
  if (name === 'netherite_block' || name === 'ancient_debris') return { relief: 0.7, roughness: 0.3 };
  if (name === 'netherrack' || name === 'magma') return { relief: 1.4, roughness: 0.95 };
  if (name === 'end_stone' || name.startsWith('end_portal_frame')) return { relief: 0.8, roughness: 0.85 };
  if (name === 'end_crystal' || name === 'dragon_egg') return { relief: 0.6, roughness: 0.15 };
  if (name.endsWith('_ore')) return { relief: 1.3, roughness: 0.45 };
  if (name === 'cobblestone' || name === 'mossy_cobblestone' || name === 'gravel') return { relief: 1.5, roughness: 0.95 };
  if (name === 'bricks' || name === 'stone_bricks') return { relief: 1.2, roughness: 0.9 };
  if (name.includes('planks') || name.includes('_log')) return { relief: 0.9, roughness: 0.85 };
  if (name === 'sand' || name === 'red_sand' || name === 'snow') return { relief: 0.5, roughness: 1 };
  return { relief: 1, roughness: 0.88 };
}

/**
 * Recopie une tuile en inversant l'ordre des lignes.
 *
 * @param comps nombre de composantes par texel (4 pour du RGBA, 1 pour une
 *              hauteur).
 */
function flipRows<T extends { set(a: ArrayLike<number>, o?: number): void }>(
  src: Uint8Array | Float32Array,
  comps: number,
  dst: T,
  offset: number,
): void {
  const row = TILE * comps;
  for (let y = 0; y < TILE; y++) {
    dst.set(src.subarray((TILE - 1 - y) * row, (TILE - y) * row) as never, offset + y * row);
  }
}

/** Sobel bouclant sur le champ de hauteur → normale tangente encodée. */
function buildNormal(height: Float32Array, relief: number, roughness: number, out: Uint8Array, offset: number): void {
  const at = (x: number, y: number) => height[(((y % TILE) + TILE) % TILE) * TILE + (((x % TILE) + TILE) % TILE)];
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const dx =
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * relief;
      let ny = -dy * relief;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const i = offset + (y * TILE + x) * 4;
      out[i] = clamp255((nx * 0.5 + 0.5) * 255);
      out[i + 1] = clamp255((ny * 0.5 + 0.5) * 255);
      out[i + 2] = clamp255((nz / len * 0.5 + 0.5) * 255);
      out[i + 3] = clamp255(roughness * 255);
    }
  }
}

export interface Atlas {
  texture: DataArrayTexture;
  /** RVB = normale tangente, A = rugosité. */
  normalTexture: DataArrayTexture;
  layerCount: number;
  /** Aperçu RGBA d'une tuile, pour les icônes d'inventaire. */
  tileData(layer: number): Uint8Array;
  /** Couleur moyenne d'une tuile (0xRRGGBB), utilisée par les particules. */
  tileAverage(layer: number): number;
}

export function buildAtlas(): Atlas {
  const count = TEXTURE_NAMES.length;
  const data = new Uint8Array(STRIDE * count);
  const normals = new Uint8Array(STRIDE * count);
  const previews: Uint8Array[] = [];

  for (let i = 0; i < count; i++) {
    const name = TEXTURE_NAMES[i];
    const t = new Tile();
    const painter = PAINTERS[name] ?? PAINTERS.missing;
    // Graine dérivée du nom : la même texture est reproduite à l'identique.
    let h = 2166136261;
    for (let k = 0; k < name.length; k++) h = Math.imul(h ^ name.charCodeAt(k), 16777619);
    painter(t, mulberry32(h >>> 0));
    t.finalizeHeight();

    const { relief, roughness } = surfaceOf(name);
    // Les peintres dessinent comme sur un canevas — la ligne 0 est le haut de
    // la tuile. L'échantillonnage, lui, met v = 0 en bas de la face : sans ce
    // retournement, tout ce qui a un haut et un bas sort à l'envers (flamme des
    // torches sous le manche, frange d'herbe sous la terre, fleurs à l'envers).
    flipRows(t.data, 4, data, i * STRIDE);
    const height = new Float32Array(TILE * TILE);
    flipRows(t.height, 1, height, 0);
    buildNormal(height, relief, roughness, normals, i * STRIDE);
    // La prévisualisation garde l'orientation du peintre : les icônes de
    // l'interface sont dessinées sur un canevas, ligne 0 en haut.
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
  // Filtrage anisotrope maximal : les sols vus en rasant restent nets.
  texture.anisotropy = 16;
  texture.needsUpdate = true;

  // La carte de normales reste en espace linéaire : ce ne sont pas des couleurs.
  const normalTexture = new DataArrayTexture(normals, TILE, TILE, count);
  normalTexture.format = RGBAFormat;
  normalTexture.type = UnsignedByteType;
  normalTexture.magFilter = NearestFilter;
  normalTexture.minFilter = LinearMipmapLinearFilter;
  normalTexture.wrapS = RepeatWrapping;
  normalTexture.wrapT = RepeatWrapping;
  normalTexture.generateMipmaps = true;
  normalTexture.anisotropy = 8;
  normalTexture.needsUpdate = true;

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
    normalTexture,
    layerCount: count,
    tileData: (layer: number) => previews[layer] ?? previews[0],
    tileAverage: (layer: number) => averages[layer] ?? 0x808080,
  };
}
