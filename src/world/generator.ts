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
import { emitStructures, villagesNear, type Anchor, type LootKind, type StructCtx, type StructRealm } from './structures';

export type WorldType = 'normal' | 'flat' | 'oneblock';
/** Dimension courante. Chacune a son propre relief et sa propre sauvegarde. */
export type Dimension = 'overworld' | 'nether' | 'end';
/** Ce que le générateur produit réellement : type de monde ou dimension. */
export type GenKind = WorldType | 'nether' | 'end';

/** Plafond de roche du Nether : au-dessus, c'est la bedrock du toit. */
const NETHER_ROOF = 100;
/** Niveau des mers de lave. */
export const NETHER_LAVA = 26;

/** Altitude et position du bloc unique du mode « oneblock ». */
export const ONEBLOCK_X = 0;
export const ONEBLOCK_Y = 64;
export const ONEBLOCK_Z = 0;

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

  /** Ce que ce générateur produit : monde normal, superplat, oneblock, Nether ou End. */
  readonly type: GenKind;
  /** Monde superplat : idéal pour bâtir sans terrain qui gêne. */
  get flat(): boolean {
    return this.type === 'flat';
  }

  /**
   * Mémo des altitudes, indispensable aux structures : chaque chunk touché par
   * un village rejoue la totalité de sa construction, ce qui interroge le
   * relief des centaines de fois aux mêmes coordonnées.
   */
  private heightCache = new Map<number, number>();

  constructor(seed: number, type: GenKind = 'normal') {
    this.seed = seed | 0;
    this.type = type;
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
    // 16 bits par axe : les coordonnées interrogées pendant la génération d'un
    // chunk tiennent dans quelques centaines de blocs, aucune collision possible.
    const key = ((x & 0xffff) << 16) | (z & 0xffff);
    const hit = this.heightCache.get(key);
    if (hit !== undefined) return hit;
    const h = this.computeHeight(x, z);
    this.heightCache.set(key, h);
    return h;
  }

  private computeHeight(x: number, z: number): number {
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

    if (this.heightCache.size > 40000) this.heightCache.clear();

    if (this.type === 'flat') return this.generateFlat(blocks, heightmap, biomes);
    if (this.type === 'oneblock') return this.generateOneblock(blocks, heightmap, biomes, cx, cz);
    if (this.type === 'nether') return this.generateNether(blocks, heightmap, biomes, cx, cz);
    if (this.type === 'end') return this.generateEnd(blocks, heightmap, biomes, cx, cz);

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

    // 6) Structures. Elles passent en dernier et écrasent ce qu'elles trouvent :
    //    une maison ne doit pas se retrouver traversée par un arbre.
    this.placeStructures(blocks, cx, cz);
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          if (blocks[voxelIndex(lx, y, lz)] !== 0) { heightmap[lx + lz * CHUNK_X] = y; break; }
        }
      }
    }

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

  /**
   * Mode « oneblock » : le monde est intégralement vide, à l'exception d'un
   * unique bloc à l'origine. Tout le reste vient de ce bloc, que le jeu
   * régénère à chaque fois qu'on le casse.
   */
  private generateOneblock(blocks: Uint8Array, heightmap: Uint8Array, biomes: Uint8Array, cx: number, cz: number): GenResult {
    biomes.fill(Biome.Plains);
    const lx = ONEBLOCK_X - cx * CHUNK_X;
    const lz = ONEBLOCK_Z - cz * CHUNK_Z;
    if (lx >= 0 && lx < CHUNK_X && lz >= 0 && lz < CHUNK_Z) {
      blocks[voxelIndex(lx, ONEBLOCK_Y, lz)] = B.grass;
      heightmap[lx + lz * CHUNK_X] = ONEBLOCK_Y;
    }
    return { blocks, biomes, heightmap, overflow: new Int32Array(0) };
  }

  // --- Nether -------------------------------------------------------------

  /**
   * Le Nether : une caverne close entre deux couches de bedrock. Le relief
   * vient d'un bruit 3D seuillé — on creuse dans du plein au lieu d'empiler des
   * colonnes — d'où les voûtes, les surplombs et les puits verticaux.
   * Les creux sous le niveau 26 se remplissent de lave.
   */
  private generateNether(blocks: Uint8Array, heightmap: Uint8Array, biomes: Uint8Array, cx: number, cz: number): GenResult {
    const ox = cx * CHUNK_X;
    const oz = cz * CHUNK_Z;
    const rnd = mulberry32((cx * 341873128712 + cz * 132897987541 + this.seed + 7717) | 0);
    biomes.fill(Biome.Badlands);

    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const wx = ox + lx, wz = oz + lz;
        for (let y = 1; y < NETHER_ROOF + 4; y++) {
          let id = B.netherrack;
          if (y < NETHER_ROOF) {
            // Densité : positive = roche. Les grandes cavités viennent du bruit
            // basse fréquence, les tunnels étroits du bruit ridged.
            const d = fbm3(this.nCaveC, wx / 90, y / 60, wz / 90, 3);
            const t = 1 - Math.abs(this.nCaveA.noise3(wx / 70, y / 44, wz / 70));
            // Le sol et le plafond restent pleins : la dimension est fermée.
            const edge = Math.min(y / 8, (NETHER_ROOF - y) / 10, 1);
            const solid = d * 0.75 + (t > 0.86 ? -0.55 : 0.1) + (1 - edge) * 0.9;
            if (solid < 0.34) {
              blocks[voxelIndex(lx, y, lz)] = y <= NETHER_LAVA ? B.lava : 0;
              continue;
            }
            // Filons : quartz partout, débris antiques seulement en profondeur.
            const v = this.nStone.noise3(wx / 18, y / 15, wz / 18);
            if (v > 0.74) id = B.nether_quartz_ore;
            else if (y < 34 && v < -0.82) id = B.ancient_debris;
            else if (v < -0.66 && y < 46) id = B.magma_block;
          } else {
            id = B.bedrock;
          }
          blocks[voxelIndex(lx, y, lz)] = id;
        }
        blocks[voxelIndex(lx, 0, lz)] = B.bedrock;
        // Toit irrégulier : la dalle de bedrock ne doit pas être une table lisse.
        for (let y = NETHER_ROOF; y < NETHER_ROOF + 4; y++) {
          if (hash3(wx, y, wz, this.seed ^ 0x1a7) < (y - NETHER_ROOF) / 4) blocks[voxelIndex(lx, y, lz)] = 0;
        }
      }
    }

    // Habillage : sable des âmes au bord des mers de lave, pierre lumineuse au plafond.
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        for (let y = NETHER_LAVA - 2; y <= NETHER_LAVA + 2; y++) {
          const i = voxelIndex(lx, y, lz);
          if (blocks[i] === B.netherrack && blocks[voxelIndex(lx, y + 1, lz)] === 0 && rnd() < 0.35) {
            blocks[i] = B.soul_sand;
          }
        }
        // Amas de pierre lumineuse accrochés sous les voûtes.
        if (rnd() < 0.05) {
          for (let y = NETHER_ROOF - 6; y > 30; y--) {
            const i = voxelIndex(lx, y, lz);
            if (blocks[i] !== 0 || blocks[voxelIndex(lx, y + 1, lz)] === 0) continue;
            blocks[i] = B.glowstone;
            if (rnd() < 0.6) blocks[voxelIndex(lx, y - 1, lz)] = B.glowstone;
            break;
          }
        }
        let top = 0;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) if (blocks[voxelIndex(lx, y, lz)] !== 0) { top = y; break; }
        heightmap[lx + lz * CHUNK_X] = top;
      }
    }

    this.placeStructures(blocks, cx, cz);
    return { blocks, biomes, heightmap, overflow: new Int32Array(0) };
  }

  // --- End ------------------------------------------------------------------

  /**
   * L'End : des îles de pierre de l'End flottant dans le vide. Une île centrale
   * autour de l'origine — celle où l'on arrive — puis un archipel dispersé.
   */
  private generateEnd(blocks: Uint8Array, heightmap: Uint8Array, biomes: Uint8Array, cx: number, cz: number): GenResult {
    const ox = cx * CHUNK_X;
    const oz = cz * CHUNK_Z;
    const rnd = mulberry32((cx * 341873128712 + cz * 132897987541 + this.seed + 4242) | 0);
    biomes.fill(Biome.StonyPeaks);
    const CORE = 62;

    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const wx = ox + lx, wz = oz + lz;
        const rad = Math.hypot(wx, wz);
        // Île principale : un disque de 48 blocs, épais au centre, effilé au bord.
        const core = rad < 48 ? 1 - rad / 48 : 0;
        // Archipel : bruit 2D seuillé, avec un vide franc autour de l'île centrale.
        const far = clamp((rad - 90) / 160, 0, 1);
        const isle = Math.max(0, fbm2(this.nCont, wx / 180, wz / 180, 3) * far - 0.12);

        const thick = core * 14 + isle * 26;
        if (thick < 1.5) { heightmap[lx + lz * CHUNK_X] = 0; continue; }
        const top = Math.round(CORE + (core > 0 ? 0 : fbm2(this.nDetail, wx / 70, wz / 70, 2) * 20));
        const bottom = Math.round(top - thick);
        for (let y = bottom; y <= top; y++) {
          if (y < 4 || y >= WORLD_HEIGHT) continue;
          blocks[voxelIndex(lx, y, lz)] = B.end_stone;
        }
        // Colonnes d'obsidienne dressées sur l'île centrale, chacune couronnée
        // d'un cristal : c'est le décor — et l'enjeu — du combat.
        if (core > 0.55 && rnd() < 0.004) {
          const height = 9 + Math.floor(rnd() * 12);
          for (let y = top + 1; y <= top + height; y++) {
            if (y < WORLD_HEIGHT) blocks[voxelIndex(lx, y, lz)] = B.obsidian;
          }
          if (top + height + 2 < WORLD_HEIGHT) blocks[voxelIndex(lx, top + height + 2, lz)] = B.end_crystal;
        }
        // Veines de purpur dans les îles lointaines.
        if (isle > 0.2 && rnd() < 0.02) blocks[voxelIndex(lx, Math.max(4, top), lz)] = B.purpur_block;
        heightmap[lx + lz * CHUNK_X] = Math.min(WORLD_HEIGHT - 1, top);
      }
    }
    return { blocks, biomes, heightmap, overflow: new Int32Array(0) };
  }

  // --- Structures ---------------------------------------------------------

  /**
   * Contexte de construction borné à un chunk. Les blocs qui tombent hors des
   * bornes sont simplement ignorés : le chunk voisin rejouera la même
   * construction et posera sa part. Rien à propager, rien à synchroniser.
   */
  private structCtx(blocks: Uint8Array, ox: number, oz: number, onChest?: (x: number, y: number, z: number, k: LootKind) => void): StructCtx {
    return {
      seed: this.seed,
      heightAt: (x, z) => this.heightAt(x, z),
      biomeAt: (x, z, h) => this.biomeAt(x, z, h),
      set: (x, y, z, id, force) => {
        if (y < 1 || y >= WORLD_HEIGHT) return;
        const lx = x - ox;
        const lz = z - oz;
        if (lx < 0 || lx >= CHUNK_X || lz < 0 || lz >= CHUNK_Z) return;
        const i = voxelIndex(lx, y, lz);
        if (force || blocks[i] === 0) blocks[i] = id;
      },
      chest: (x, y, z, k) => onChest?.(x, y, z, k),
    };
  }

  /** Le Nether a ses propres structures ; le superplat et l'End n'en ont pas. */
  private get realm(): StructRealm | null {
    if (this.type === 'normal') return 'overworld';
    if (this.type === 'nether') return 'nether';
    return null;
  }

  /** Pose les structures dont l'emprise recoupe le chunk. */
  private placeStructures(blocks: Uint8Array, cx: number, cz: number): void {
    const realm = this.realm;
    if (!realm) return;
    const ox = cx * CHUNK_X;
    const oz = cz * CHUNK_Z;
    emitStructures(this.structCtx(blocks, ox, oz), ox, oz, ox + CHUNK_X - 1, oz + CHUNK_Z - 1, realm);
  }

  /**
   * Nature du butin d'un coffre de structure, ou `null` si ce coffre n'en est
   * pas un. Le thread principal rejoue la génération des structures autour du
   * point demandé, sans écrire un seul bloc.
   */
  lootKindAt(x: number, y: number, z: number): LootKind | null {
    const realm = this.realm;
    if (!realm) return null;
    let found: LootKind | null = null;
    const ctx: StructCtx = {
      seed: this.seed,
      heightAt: (ax, az) => this.heightAt(ax, az),
      biomeAt: (ax, az, h) => this.biomeAt(ax, az, h),
      set: () => {},
      chest: (cxw, cyw, czw, k) => {
        if (cxw === x && cyw === y && czw === z) found = k;
      },
    };
    emitStructures(ctx, x, z, x, z, realm);
    return found;
  }

  /** Villages proches, pour peupler les environs en villageois et golems. */
  villagesAround(x: number, z: number, radius: number): Anchor[] {
    const ctx: StructCtx = {
      seed: this.seed,
      heightAt: (ax, az) => this.heightAt(ax, az),
      biomeAt: (ax, az, h) => this.biomeAt(ax, az, h),
      set: () => {},
      chest: () => {},
    };
    return villagesNear(ctx, x, z, radius);
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
