/**
 * Génération procédurale du terrain.
 *
 * Pipeline par chunk :
 *   1. climat (continentalité, érosion, relief, température, humidité)
 *   2. colonne de roche + couches de surface dépendantes du biome
 *   3. creusement des grottes (bruit 3D interpolé sur grille grossière)
 *   4. remplissage des océans / lacs, bedrock
 *   5. filons de minerai
 *   6. décoration (arbres, végétation, citrouilles, cannes à sucre…)
 *
 * Les blocs de structures qui débordent du chunk sont renvoyés dans `overflow`
 * et appliqués par le thread principal sur les chunks voisins.
 */

import { CHUNK_X, CHUNK_Z, WORLD_HEIGHT, SEA_LEVEL, voxelIndex } from '../core/constants';
import { B } from './blocks';
import { Biome, biomeDef, pickBiome, type TreeKind } from './biomes';
import { Simplex, fbm2, fbm3, ridged2, mulberry32, hash3, clamp, spline, lerp } from './noise';

export interface GenResult {
  blocks: Uint8Array;
  biomes: Uint8Array;
  heightmap: Uint8Array;
  /** Débordements de structures : quadruplets [xWorld, y, zWorld, blockId]. */
  overflow: Int32Array;
}

const CAVE_STRIDE = 4;
const CAVE_TOP = 112;
const GRID_X = CHUNK_X / CAVE_STRIDE + 1; // 5
const GRID_Y = CAVE_TOP / CAVE_STRIDE + 1; // 29
const GRID_Z = CHUNK_Z / CAVE_STRIDE + 1; // 5

const CONT_SPLINE: [number, number][] = [
  [-1.0, 26], [-0.65, 34], [-0.42, 46], [-0.22, 57], [-0.08, 62],
  [0.02, 66], [0.2, 72], [0.45, 82], [0.72, 96], [1.0, 112],
];
const EROSION_AMP: [number, number][] = [
  [-1.0, 46], [-0.5, 30], [-0.1, 16], [0.25, 8], [0.6, 4], [1.0, 2],
];

export class TerrainGenerator {
  readonly seed: number;
  private readonly nCont: Simplex;
  private readonly nEro: Simplex;
  private readonly nPv: Simplex;
  private readonly nTemp: Simplex;
  private readonly nHum: Simplex;
  private readonly nDetail: Simplex;
  private readonly nCaveA: Simplex;
  private readonly nCaveB: Simplex;
  private readonly nCaveC: Simplex;
  private readonly nStone: Simplex;

  // Tampons réutilisés entre chunks pour éviter la pression GC.
  private caveGrid = new Float32Array(GRID_X * GRID_Y * GRID_Z);
  private colHeight = new Int16Array(CHUNK_X * CHUNK_Z);
  private colBiome = new Uint8Array(CHUNK_X * CHUNK_Z);

  /** Monde superplat : idéal pour bâtir sans terrain qui gêne. */
  readonly flat: boolean;

  constructor(seed: number, flat = false) {
    this.seed = seed | 0;
    this.flat = flat;
    const s = this.seed;
    this.nCont = new Simplex(s + 1);
    this.nEro = new Simplex(s + 2);
    this.nPv = new Simplex(s + 3);
    this.nTemp = new Simplex(s + 4);
    this.nHum = new Simplex(s + 5);
    this.nDetail = new Simplex(s + 6);
    this.nCaveA = new Simplex(s + 7);
    this.nCaveB = new Simplex(s + 8);
    this.nCaveC = new Simplex(s + 9);
    this.nStone = new Simplex(s + 10);
  }

  // --- Climat -------------------------------------------------------------

  continentalness(x: number, z: number): number {
    return fbm2(this.nCont, x / 2100, z / 2100, 4);
  }
  erosion(x: number, z: number): number {
    return fbm2(this.nEro, x / 1100, z / 1100, 3);
  }
  temperature(x: number, z: number): number {
    return clamp(fbm2(this.nTemp, x / 2600, z / 2600, 3) * 1.35, -1, 1);
  }
  humidity(x: number, z: number): number {
    return clamp(fbm2(this.nHum, x / 1700, z / 1700, 3) * 1.3, -1, 1);
  }

  /** Altitude du terrain (sommet solide) pour une colonne du monde. */
  heightAt(x: number, z: number): number {
    const cont = this.continentalness(x, z);
    const ero = this.erosion(x, z);
    const base = spline(CONT_SPLINE, cont);
    const amp = spline(EROSION_AMP, ero);
    const pv = ridged2(this.nPv, x / 420, z / 420, 4) * 2 - 1;
    const detail = fbm2(this.nDetail, x / 90, z / 90, 3) * 3.2;
    // Les océans restent lisses : on atténue le relief sous le niveau de la mer.
    const oceanic = clamp((base - (SEA_LEVEL - 8)) / 14, 0, 1);
    let h = base + pv * amp * 0.55 * oceanic + detail * (0.35 + 0.65 * oceanic);
    // Terrasses légères dans les zones très érodées (aspect « mesa »).
    if (ero > 0.55 && h > SEA_LEVEL + 4) {
      const step = 5;
      h = lerp(h, Math.round(h / step) * step, (ero - 0.55) * 1.6);
    }
    return clamp(Math.round(h), 3, WORLD_HEIGHT - 12);
  }

  biomeAt(x: number, z: number, height?: number): Biome {
    const h = height ?? this.heightAt(x, z);
    return pickBiome(
      this.continentalness(x, z),
      this.temperature(x, z),
      this.humidity(x, z),
      this.erosion(x, z),
      h,
      SEA_LEVEL,
    );
  }

  // --- Grottes ------------------------------------------------------------

  private buildCaveGrid(ox: number, oz: number): void {
    const g = this.caveGrid;
    let i = 0;
    for (let gy = 0; gy < GRID_Y; gy++) {
      const y = gy * CAVE_STRIDE;
      for (let gz = 0; gz < GRID_Z; gz++) {
        const z = oz + gz * CAVE_STRIDE;
        for (let gx = 0; gx < GRID_X; gx++, i++) {
          const x = ox + gx * CAVE_STRIDE;
          // « Spaghettis » : intersection de deux bruits ridged → tunnels étroits.
          const a = 1 - Math.abs(this.nCaveA.noise3(x / 96, y / 56, z / 96));
          const b = 1 - Math.abs(this.nCaveB.noise3(x / 96, y / 56, z / 96 + 51.3));
          let tunnel = Math.min(a, b);
          // Les tunnels s'élargissent en profondeur.
          tunnel += clamp((30 - y) / 120, 0, 0.06);
          // « Cavernes » : poches volumineuses sous 48.
          const cheese = fbm3(this.nCaveC, x / 130, y / 90, z / 130, 3);
          const cheeseMask = clamp((46 - y) / 26, 0, 1) * clamp((y - 6) / 8, 0, 1);
          const cav = cheese * cheeseMask;
          g[i] = Math.max(tunnel - 0.918, cav - 0.42);
        }
      }
    }
  }

  private caveAt(lx: number, y: number, lz: number): number {
    if (y >= CAVE_TOP) return -1;
    const gx = lx / CAVE_STRIDE, gy = y / CAVE_STRIDE, gz = lz / CAVE_STRIDE;
    const x0 = gx | 0, y0 = gy | 0, z0 = gz | 0;
    const fx = gx - x0, fy = gy - y0, fz = gz - z0;
    const g = this.caveGrid;
    const idx = (X: number, Y: number, Z: number) => X + GRID_X * (Z + GRID_Z * Y);
    const x1 = Math.min(x0 + 1, GRID_X - 1);
    const y1 = Math.min(y0 + 1, GRID_Y - 1);
    const z1 = Math.min(z0 + 1, GRID_Z - 1);
    const c00 = lerp(g[idx(x0, y0, z0)], g[idx(x1, y0, z0)], fx);
    const c10 = lerp(g[idx(x0, y0, z1)], g[idx(x1, y0, z1)], fx);
    const c01 = lerp(g[idx(x0, y1, z0)], g[idx(x1, y1, z0)], fx);
    const c11 = lerp(g[idx(x0, y1, z1)], g[idx(x1, y1, z1)], fx);
    return lerp(lerp(c00, c10, fz), lerp(c01, c11, fz), fy);
  }

  // --- Génération d'un chunk ---------------------------------------------

  generate(cx: number, cz: number): GenResult {
    const blocks = new Uint8Array(CHUNK_X * CHUNK_Z * WORLD_HEIGHT);
    const heightmap = new Uint8Array(CHUNK_X * CHUNK_Z);
    const biomes = new Uint8Array(CHUNK_X * CHUNK_Z);
    const overflow: number[] = [];
    const ox = cx * CHUNK_X;
    const oz = cz * CHUNK_Z;

    if (this.flat) return this.generateFlat(blocks, heightmap, biomes);

    this.buildCaveGrid(ox, oz);

    // 1) Colonnes de roche et couches de surface.
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const wx = ox + lx;
        const wz = oz + lz;
        const h = this.heightAt(wx, wz);
        const biome = this.biomeAt(wx, wz, h);
        const bd = biomeDef(biome);
        const ci = lx + lz * CHUNK_X;
        this.colHeight[ci] = h;
        this.colBiome[ci] = biome;
        biomes[ci] = biome;

        const submerged = h < SEA_LEVEL;
        const surfaceBlock = submerged ? bd.underwater : bd.surface;
        const depth = bd.depth;

        for (let y = 0; y <= h; y++) {
          let b: number;
          if (y === h && !submerged) b = surfaceBlock;
          else if (y > h - depth) b = submerged ? bd.underwater : bd.subsurface;
          else b = B.stone;

          // Variantes rocheuses pour casser la monotonie.
          if (b === B.stone && y < h - depth) {
            const v = this.nStone.noise3(wx / 26, y / 22, wz / 26);
            if (v > 0.62) b = B.andesite;
            else if (v < -0.68) b = B.granite;
            else if (v > 0.4 && v < 0.46) b = B.diorite;
          }
          blocks[voxelIndex(lx, y, lz)] = b;
        }

        // Bedrock irrégulier.
        blocks[voxelIndex(lx, 0, lz)] = B.bedrock;
        for (let y = 1; y < 4; y++) {
          if (hash3(wx, y, wz, this.seed ^ 0x5eed) < (4 - y) / 4) blocks[voxelIndex(lx, y, lz)] = B.bedrock;
        }
      }
    }

    // 2) Grottes : on évite de perforer le plancher océanique pour ne pas vider les mers.
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const ci = lx + lz * CHUNK_X;
        const h = this.colHeight[ci];
        const top = Math.min(h, CAVE_TOP - 1);
        const ceiling = h < SEA_LEVEL ? Math.min(top, SEA_LEVEL - 6) : top;
        for (let y = 4; y <= ceiling; y++) {
          const idx = voxelIndex(lx, y, lz);
          const b = blocks[idx];
          if (b === B.bedrock || b === 0) continue;
          if (this.caveAt(lx, y, lz) > 0) {
            // Lave au fond des cavernes profondes.
            blocks[idx] = y < 11 ? B.lava : 0;
          }
        }
      }
    }

    // 3) Océans, lacs et couverture neigeuse.
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const ci = lx + lz * CHUNK_X;
        const h = this.colHeight[ci];
        const bd = biomeDef(this.colBiome[ci] as Biome);
        for (let y = h + 1; y <= SEA_LEVEL; y++) {
          if (blocks[voxelIndex(lx, y, lz)] === 0) blocks[voxelIndex(lx, y, lz)] = B.water;
        }
        if (h >= SEA_LEVEL && h >= bd.snowLine) {
          const top = voxelIndex(lx, h, lz);
          if (blocks[top] === B.grass || blocks[top] === B.stone || blocks[top] === B.dirt) {
            blocks[voxelIndex(lx, h + 1, lz)] = B.snow;
          }
        }
        // Glace de surface dans les biomes froids.
        if (bd.temperature < -0.2 && h < SEA_LEVEL) {
          const s = voxelIndex(lx, SEA_LEVEL, lz);
          if (blocks[s] === B.water) blocks[s] = B.ice;
        }
        // Hauteur du sommet non-air pour la carte de hauteur.
        let top = 0;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          if (blocks[voxelIndex(lx, y, lz)] !== 0) { top = y; break; }
        }
        heightmap[ci] = top;
      }
    }

    // 4) Minerais.
    this.placeOres(blocks, cx, cz);

    // 5) Décoration.
    this.decorate(blocks, heightmap, cx, cz, overflow);

    return { blocks, biomes, heightmap, overflow: Int32Array.from(overflow) };
  }

  /** Bedrock, trois couches de terre, une d'herbe : rien d'autre. */
  private generateFlat(blocks: Uint8Array, heightmap: Uint8Array, biomes: Uint8Array): GenResult {
    const top = 4;
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        blocks[voxelIndex(lx, 0, lz)] = B.bedrock;
        for (let y = 1; y < top; y++) blocks[voxelIndex(lx, y, lz)] = B.dirt;
        blocks[voxelIndex(lx, top, lz)] = B.grass;
        heightmap[lx + lz * CHUNK_X] = top;
        biomes[lx + lz * CHUNK_X] = Biome.Plains;
      }
    }
    return { blocks, biomes, heightmap, overflow: new Int32Array(0) };
  }

  // --- Minerais -----------------------------------------------------------

  private placeOres(blocks: Uint8Array, cx: number, cz: number): void {
    const rnd = mulberry32((cx * 341873128712 + cz * 132897987541 + this.seed) | 0);
    const veins: [number, number, number, number, number][] = [
      // [bloc, tentatives, taille, yMin, yMax]
      [B.coal_ore, 20, 14, 8, 110],
      [B.iron_ore, 16, 9, 4, 68],
      [B.gold_ore, 4, 8, 4, 34],
      [B.redstone_ore, 6, 8, 4, 22],
      [B.lapis_ore, 3, 7, 4, 32],
      [B.diamond_ore, 2, 6, 4, 16],
      [B.emerald_ore, 1, 3, 4, 30],
      [B.gravel, 6, 24, 20, 90],
      [B.granite, 5, 30, 4, 80],
      [B.andesite, 5, 30, 4, 80],
      [B.diorite, 5, 30, 4, 80],
      [B.clay, 2, 12, SEA_LEVEL - 6, SEA_LEVEL + 1],
    ];

    for (const [ore, tries, size, yMin, yMax] of veins) {
      for (let t = 0; t < tries; t++) {
        if (rnd() > 0.85 && ore === B.emerald_ore) continue;
        let x = rnd() * CHUNK_X;
        let y = yMin + rnd() * (yMax - yMin);
        let z = rnd() * CHUNK_Z;
        const n = 3 + Math.floor(rnd() * size);
        // Marche aléatoire : donne des filons allongés plutôt que des cubes.
        for (let i = 0; i < n; i++) {
          x += rnd() * 1.6 - 0.8;
          y += rnd() * 1.4 - 0.7;
          z += rnd() * 1.6 - 0.8;
          const bx = Math.round(x), by = Math.round(y), bz = Math.round(z);
          if (bx < 0 || bx >= CHUNK_X || bz < 0 || bz >= CHUNK_Z || by < 1 || by >= WORLD_HEIGHT) continue;
          const idx = voxelIndex(bx, by, bz);
          const cur = blocks[idx];
          if (cur === B.stone || cur === B.andesite || cur === B.granite || cur === B.diorite) blocks[idx] = ore;
        }
      }
    }
  }

  // --- Décoration ---------------------------------------------------------

  private decorate(blocks: Uint8Array, heightmap: Uint8Array, cx: number, cz: number, overflow: number[]): void {
    const ox = cx * CHUNK_X;
    const oz = cz * CHUNK_Z;
    const rnd = mulberry32((cx * 1013904223 + cz * 1664525 + this.seed * 22695477) | 0);

    const set = (wx: number, wy: number, wz: number, id: number, force = false) => {
      if (wy < 0 || wy >= WORLD_HEIGHT) return;
      const lx = wx - ox;
      const lz = wz - oz;
      if (lx >= 0 && lx < CHUNK_X && lz >= 0 && lz < CHUNK_Z) {
        const idx = voxelIndex(lx, wy, lz);
        if (force || blocks[idx] === 0) blocks[idx] = id;
      } else {
        overflow.push(wx, wy, wz, force ? id | 0x100 : id);
      }
    };

    const surfaceOf = (lx: number, lz: number): number => {
      // Sommet solide en ignorant la neige déjà posée.
      for (let y = Math.min(heightmap[lx + lz * CHUNK_X], WORLD_HEIGHT - 2); y > 0; y--) {
        const b = blocks[voxelIndex(lx, y, lz)];
        if (b !== 0 && b !== B.snow && b !== B.water && b !== B.ice) return y;
      }
      return 0;
    };

    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const ci = lx + lz * CHUNK_X;
        const bd = biomeDef(this.colBiome[ci] as Biome);
        const sy = surfaceOf(lx, lz);
        const ground = blocks[voxelIndex(lx, sy, lz)];
        const above = voxelIndex(lx, sy + 1, lz);
        const wx = ox + lx, wz = oz + lz;

        if (sy < 2 || blocks[above] !== 0) continue;
        const isSoil = ground === B.grass || ground === B.dirt || ground === B.coarse_dirt;
        const isSand = ground === B.sand || ground === B.red_sand;

        // Arbres.
        if ((isSoil || (isSand && bd.tree === 'cactus')) && rnd() < bd.treeDensity) {
          let kind = bd.tree;
          if (bd.secondaryTree && rnd() < (bd.secondaryChance ?? 0)) kind = bd.secondaryTree;
          this.buildTree(kind, wx, sy + 1, wz, rnd, set);
          continue;
        }

        // Cannes à sucre au bord de l'eau.
        if ((isSand || isSoil) && sy <= SEA_LEVEL + 1 && rnd() < 0.08 && this.nearWater(blocks, lx, sy, lz)) {
          const n = 1 + Math.floor(rnd() * 3);
          for (let i = 0; i < n; i++) set(wx, sy + 1 + i, wz, B.sugar_cane);
          continue;
        }

        // Tapis végétal.
        if (isSoil && rnd() < bd.grassDensity) {
          set(wx, sy + 1, wz, bd.temperature < 0.3 && rnd() < 0.4 ? B.fern : B.tall_grass);
          continue;
        }
        if (isSoil && rnd() < bd.flowerDensity) {
          const r = rnd();
          set(wx, sy + 1, wz, r < 0.4 ? B.dandelion : r < 0.8 ? B.poppy : B.blue_orchid);
          continue;
        }
        if (isSand && rnd() < 0.012 && bd.id === Biome.Desert) {
          set(wx, sy + 1, wz, B.dead_bush);
          continue;
        }
        // Citrouilles éparses.
        if (isSoil && rnd() < 0.0012) {
          set(wx, sy + 1, wz, B.pumpkin);
          continue;
        }
        // Champignons dans les grottes ouvertes et les marais sombres.
        if (isSoil && bd.id === Biome.Swamp && rnd() < 0.02) {
          set(wx, sy + 1, wz, rnd() < 0.5 ? B.brown_mushroom : B.red_mushroom);
        }
      }
    }

    // Champignons souterrains dans les cavités.
    for (let t = 0; t < 12; t++) {
      const lx = Math.floor(rnd() * CHUNK_X);
      const lz = Math.floor(rnd() * CHUNK_Z);
      const y = 6 + Math.floor(rnd() * 40);
      const idx = voxelIndex(lx, y, lz);
      const below = blocks[voxelIndex(lx, y - 1, lz)];
      if (blocks[idx] === 0 && (below === B.stone || below === B.dirt || below === B.andesite)) {
        blocks[idx] = rnd() < 0.5 ? B.brown_mushroom : B.red_mushroom;
      }
    }
  }

  private nearWater(blocks: Uint8Array, lx: number, y: number, lz: number): boolean {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of dirs) {
      const x = lx + dx, z = lz + dz;
      if (x < 0 || x >= CHUNK_X || z < 0 || z >= CHUNK_Z) continue;
      if (blocks[voxelIndex(x, y, z)] === B.water) return true;
    }
    return false;
  }

  // --- Arbres -------------------------------------------------------------

  private buildTree(
    kind: TreeKind,
    x: number,
    y: number,
    z: number,
    rnd: () => number,
    set: (x: number, y: number, z: number, id: number, force?: boolean) => void,
  ): void {
    const blob = (cxp: number, cyp: number, czp: number, rx: number, ry: number, leaf: number, jitter = 0.25) => {
      for (let dy = -ry; dy <= ry; dy++) {
        for (let dz = -rx; dz <= rx; dz++) {
          for (let dx = -rx; dx <= rx; dx++) {
            const d = (dx * dx + dz * dz) / (rx * rx) + (dy * dy) / (ry * ry);
            if (d > 1 + (rnd() - 0.5) * jitter) continue;
            set(cxp + dx, cyp + dy, czp + dz, leaf);
          }
        }
      }
    };

    switch (kind) {
      case 'oak':
      case 'swamp_oak': {
        const h = 4 + Math.floor(rnd() * 3);
        for (let i = 0; i < h; i++) set(x, y + i, z, B.oak_log, true);
        blob(x, y + h, z, 2, 2, B.oak_leaves);
        set(x, y + h + 1, z, B.oak_leaves);
        if (kind === 'swamp_oak') {
          // Lianes suggérées par des feuilles pendantes.
          for (let i = 0; i < 4; i++) {
            const a = rnd() * Math.PI * 2;
            set(x + Math.round(Math.cos(a) * 2), y + h - 2 - Math.floor(rnd() * 2), z + Math.round(Math.sin(a) * 2), B.oak_leaves);
          }
        }
        break;
      }
      case 'big_oak': {
        const h = 7 + Math.floor(rnd() * 4);
        for (let i = 0; i < h; i++) {
          set(x, y + i, z, B.oak_log, true);
          if (i > 2 && rnd() < 0.35) {
            const dx = rnd() < 0.5 ? 1 : -1;
            const dz = rnd() < 0.5 ? 1 : -1;
            set(x + dx, y + i, z, B.oak_log, true);
            set(x, y + i, z + dz, B.oak_log, true);
            blob(x + dx * 2, y + i + 1, z + dz * 2, 2, 2, B.oak_leaves);
          }
        }
        blob(x, y + h, z, 3, 3, B.oak_leaves);
        break;
      }
      case 'birch': {
        const h = 5 + Math.floor(rnd() * 3);
        for (let i = 0; i < h; i++) set(x, y + i, z, B.birch_log, true);
        blob(x, y + h, z, 2, 2, B.birch_leaves);
        set(x, y + h + 1, z, B.birch_leaves);
        break;
      }
      case 'spruce':
      case 'tall_spruce': {
        const h = kind === 'tall_spruce' ? 9 + Math.floor(rnd() * 5) : 6 + Math.floor(rnd() * 3);
        for (let i = 0; i < h; i++) set(x, y + i, z, B.spruce_log, true);
        let r = 2;
        for (let i = h - 1; i >= 2; i--) {
          const layer = (h - i) % 3;
          const rr = layer === 0 ? r : Math.max(1, r - 1);
          for (let dz = -rr; dz <= rr; dz++)
            for (let dx = -rr; dx <= rr; dx++) {
              if (Math.abs(dx) + Math.abs(dz) > rr + 1) continue;
              if (dx === 0 && dz === 0) continue;
              set(x + dx, y + i, z + dz, B.spruce_leaves);
            }
          if (layer === 2 && r < 3 && i < h - 4) r++;
        }
        set(x, y + h, z, B.spruce_leaves);
        set(x, y + h + 1, z, B.spruce_leaves);
        break;
      }
      case 'jungle': {
        const h = 9 + Math.floor(rnd() * 8);
        for (let i = 0; i < h; i++) {
          set(x, y + i, z, B.jungle_log, true);
          if (rnd() < 0.5) set(x + 1, y + i, z, B.jungle_log, true);
        }
        blob(x, y + h, z, 3, 2, B.jungle_leaves);
        blob(x, y + h - 3, z, 2, 1, B.jungle_leaves, 0.6);
        break;
      }
      case 'acacia': {
        const h = 5 + Math.floor(rnd() * 3);
        const dx = rnd() < 0.5 ? 1 : -1;
        const dz = rnd() < 0.5 ? 1 : -1;
        for (let i = 0; i < h; i++) set(x, y + i, z, B.oak_log, true);
        let bx = x, bz = z;
        for (let i = 0; i < 3; i++) {
          bx += dx;
          bz += i % 2 === 0 ? dz : 0;
          set(bx, y + h + i, bz, B.oak_log, true);
        }
        // Canopée plate caractéristique.
        for (let dzz = -3; dzz <= 3; dzz++)
          for (let dxx = -3; dxx <= 3; dxx++) {
            if (dxx * dxx + dzz * dzz > 9) continue;
            set(bx + dxx, y + h + 3, bz + dzz, B.oak_leaves);
            if (Math.abs(dxx) < 2 && Math.abs(dzz) < 2) set(bx + dxx, y + h + 4, bz + dzz, B.oak_leaves);
          }
        break;
      }
      case 'cactus': {
        const h = 1 + Math.floor(rnd() * 3);
        for (let i = 0; i < h; i++) set(x, y + i, z, B.cactus, true);
        break;
      }
      default:
        break;
    }
  }
}
