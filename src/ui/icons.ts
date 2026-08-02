/**
 * Icônes d'inventaire générées à la volée.
 *
 * Les blocs sont rendus en cube isométrique à partir des tuiles de l'atlas ;
 * les objets (outils, minerais, nourriture…) sont dessinés en pixel art
 * procédural à partir de leur couleur dominante.
 */

import { BLOCKS, RenderKind } from '../world/blocks';
import { ITEMS, type ItemDef } from '../items/items';
import type { Atlas } from '../render/atlas';
import { TILE } from '../render/atlas';

const SIZE = 32;

type Px = (x: number, y: number, r: number, g: number, b: number, a?: number) => void;

function newCanvas(): { canvas: HTMLCanvasElement; data: ImageData; put: Px } {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(SIZE, SIZE);
  const put: Px = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    data.data[i] = r;
    data.data[i + 1] = g;
    data.data[i + 2] = b;
    data.data[i + 3] = a;
  };
  return { canvas, data, put };
}

function finish(canvas: HTMLCanvasElement, data: ImageData): string {
  canvas.getContext('2d')!.putImageData(data, 0, 0);
  return canvas.toDataURL();
}

function sampleTile(tile: Uint8Array, u: number, v: number, tint: number, shade: number): [number, number, number, number] {
  const x = Math.min(TILE - 1, Math.max(0, Math.floor(u * TILE)));
  const y = Math.min(TILE - 1, Math.max(0, Math.floor(v * TILE)));
  const i = (y * TILE + x) * 4;
  const tr = ((tint >> 16) & 255) / 255;
  const tg = ((tint >> 8) & 255) / 255;
  const tb = (tint & 255) / 255;
  return [tile[i] * tr * shade, tile[i + 1] * tg * shade, tile[i + 2] * tb * shade, tile[i + 3]];
}

function blockIcon(def: ItemDef, atlas: Atlas): string {
  const block = BLOCKS[def.block];
  const { canvas, data, put } = newCanvas();
  const tint = block.tint || 0xffffff;

  if (block.render === RenderKind.Cross) {
    // Plante : on affiche simplement la texture agrandie.
    const tile = atlas.tileData(block.layers.side);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const [r, g, b, a] = sampleTile(tile, x / SIZE, y / SIZE, tint, 1);
        if (a > 100) put(x, y, r, g, b, 255);
      }
    }
    return finish(canvas, data);
  }

  const top = atlas.tileData(block.layers.top);
  const side = atlas.tileData(block.layers.side);
  const H = SIZE / 2; // demi-largeur du cube

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      // Face supérieure (losange).
      const a1 = px / H;
      const b1 = (py - H / 2) / (H / 2);
      const s = (a1 - b1) / 2;
      const t = (a1 + b1) / 2;
      if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
        const [r, g, b, al] = sampleTile(top, s, t, tint, 1);
        if (al > 40) put(px, py, r, g, b, 255);
        continue;
      }
      // Face gauche.
      const ls = px / H;
      const lt = (py - H / 2 - (H / 2) * ls) / H;
      if (ls >= 0 && ls <= 1 && lt >= 0 && lt <= 1) {
        const [r, g, b, al] = sampleTile(side, ls, lt, tint, 0.74);
        if (al > 40) put(px, py, r, g, b, 255);
        continue;
      }
      // Face droite.
      const rs = (px - H) / H;
      const rt = (py - H + (H / 2) * rs) / H;
      if (rs >= 0 && rs <= 1 && rt >= 0 && rt <= 1) {
        const [r, g, b, al] = sampleTile(side, rs, rt, tint, 0.55);
        if (al > 40) put(px, py, r, g, b, 255);
      }
    }
  }
  return finish(canvas, data);
}

/** Trace un rectangle en coordonnées 16×16, mis à l'échelle 2×. */
function rect(put: Px, x: number, y: number, w: number, h: number, c: number, shade = 1): void {
  const r = ((c >> 16) & 255) * shade;
  const g = ((c >> 8) & 255) * shade;
  const b = (c & 255) * shade;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const bx = (x + xx) * 2;
      const by = (y + yy) * 2;
      put(bx, by, r, g, b);
      put(bx + 1, by, r, g, b);
      put(bx, by + 1, r, g, b);
      put(bx + 1, by + 1, r, g, b);
    }
  }
}

const HANDLE = 0x8a6a3a;

function toolIcon(def: ItemDef): string {
  const { canvas, data, put } = newCanvas();
  const c = def.color;
  const kind = def.tool?.kind ?? 'pickaxe';

  // Manche en diagonale, du bas-gauche vers le haut-droite.
  for (let i = 0; i < 9; i++) rect(put, 4 + i, 12 - i, 1, 1, HANDLE, 1 - i * 0.02);

  switch (kind) {
    case 'pickaxe':
      rect(put, 9, 2, 5, 1, c);
      rect(put, 8, 3, 2, 1, c, 0.85);
      rect(put, 13, 3, 2, 1, c, 0.85);
      rect(put, 11, 3, 2, 2, c);
      break;
    case 'axe':
      rect(put, 10, 2, 4, 4, c);
      rect(put, 9, 3, 1, 3, c, 0.8);
      rect(put, 14, 3, 1, 2, c, 0.7);
      break;
    case 'shovel':
      rect(put, 11, 2, 4, 4, c);
      rect(put, 12, 6, 2, 1, c, 0.8);
      break;
    case 'sword':
      for (let i = 0; i < 9; i++) rect(put, 5 + i, 11 - i, 2, 2, c, 0.9 + i * 0.01);
      rect(put, 3, 12, 4, 1, 0x6a4a2a);
      rect(put, 4, 13, 2, 2, 0x6a4a2a);
      break;
    case 'shears':
      rect(put, 5, 3, 2, 7, c);
      rect(put, 9, 3, 2, 7, c, 0.85);
      rect(put, 6, 10, 4, 2, 0x4a4a4a);
      rect(put, 4, 12, 3, 3, 0x8a2a2a);
      rect(put, 9, 12, 3, 3, 0x8a2a2a);
      break;
    default:
      rect(put, 9, 2, 5, 5, c);
      break;
  }
  return finish(canvas, data);
}

function armorIcon(def: ItemDef): string {
  const { canvas, data, put } = newCanvas();
  const c = def.color;
  switch (def.armor?.slot) {
    case 0: // casque
      rect(put, 4, 3, 8, 2, c);
      rect(put, 3, 5, 10, 4, c, 0.9);
      rect(put, 3, 9, 3, 3, c, 0.75);
      rect(put, 10, 9, 3, 3, c, 0.75);
      break;
    case 1: // plastron
      rect(put, 3, 3, 10, 3, c);
      rect(put, 2, 4, 2, 7, c, 0.8);
      rect(put, 12, 4, 2, 7, c, 0.8);
      rect(put, 4, 6, 8, 7, c, 0.92);
      break;
    case 2: // jambières
      rect(put, 3, 3, 10, 3, c);
      rect(put, 3, 6, 4, 8, c, 0.88);
      rect(put, 9, 6, 4, 8, c, 0.88);
      break;
    default: // bottes
      rect(put, 3, 6, 4, 6, c, 0.9);
      rect(put, 9, 6, 4, 6, c, 0.9);
      rect(put, 2, 11, 6, 3, c, 0.75);
      rect(put, 8, 11, 6, 3, c, 0.75);
      break;
  }
  return finish(canvas, data);
}

function simpleIcon(def: ItemDef): string {
  const { canvas, data, put } = newCanvas();
  const c = def.color;
  switch (def.icon) {
    case 'gem':
      rect(put, 6, 3, 4, 1, c, 1.15);
      rect(put, 4, 4, 8, 3, c);
      rect(put, 5, 7, 6, 3, c, 0.85);
      rect(put, 6, 10, 4, 2, c, 0.7);
      rect(put, 6, 4, 2, 2, c, 1.35);
      break;
    case 'ingot':
      rect(put, 4, 6, 8, 2, c, 1.1);
      rect(put, 3, 8, 10, 3, c);
      rect(put, 4, 11, 8, 1, c, 0.75);
      rect(put, 5, 7, 3, 1, c, 1.4);
      break;
    case 'nugget':
      rect(put, 6, 4, 4, 2, c, 1.1);
      rect(put, 4, 6, 8, 4, c);
      rect(put, 5, 10, 6, 2, c, 0.8);
      rect(put, 6, 6, 2, 1, c, 1.35);
      break;
    case 'dust':
      for (const [x, y] of [[5, 5], [8, 4], [10, 6], [4, 8], [7, 8], [10, 9], [6, 11], [9, 11]] as const) {
        rect(put, x, y, 2, 2, c, 0.8 + ((x * y) % 5) * 0.08);
      }
      break;
    case 'seed':
      for (const [x, y] of [[5, 6], [8, 5], [7, 9], [10, 8]] as const) rect(put, x, y, 2, 2, c);
      break;
    case 'stick':
      for (let i = 0; i < 9; i++) rect(put, 4 + i, 12 - i, 2, 2, c, 0.85 + i * 0.015);
      break;
    case 'food':
      rect(put, 5, 4, 6, 2, c, 1.12);
      rect(put, 4, 6, 8, 5, c);
      rect(put, 5, 11, 6, 2, c, 0.78);
      rect(put, 6, 6, 2, 2, c, 1.32);
      break;
    default:
      rect(put, 4, 4, 8, 8, c);
      rect(put, 4, 4, 8, 1, c, 1.25);
      rect(put, 4, 11, 8, 1, c, 0.7);
      break;
  }
  return finish(canvas, data);
}

const cache = new Map<number, string>();

export function buildIcons(atlas: Atlas): void {
  cache.clear();
  for (const def of ITEMS) {
    if (def.id === 0) continue;
    let url: string;
    if (def.icon === 'block') url = blockIcon(def, atlas);
    else if (def.icon === 'tool') url = toolIcon(def);
    else if (def.icon === 'armor') url = armorIcon(def);
    else url = simpleIcon(def);
    cache.set(def.id, url);
  }
}

export function iconFor(def: ItemDef | null | undefined): string {
  if (!def) return '';
  return cache.get(def.id) ?? '';
}
