/**
 * Structures générées : villages, épaves, portails engloutis et coffres au
 * trésor.
 *
 * Principe : chaque structure est ancrée sur une **grille de régions** (un
 * village tous les 100 blocs, une épave tous les 128, etc.). La position exacte
 * dans la cellule, la disposition des bâtiments et le contenu des coffres
 * découlent uniquement de `(graine, cellule)` : tout est reproductible.
 *
 * Conséquence utile : un chunk n'a pas besoin d'attendre le chunk voisin. Il
 * reconstruit intégralement chaque structure dont l'emprise le touche et
 * **découpe** ce qui sort de ses bornes. Aucun débordement à propager, donc
 * aucune couture visible quand on arrive par le bord.
 *
 * Le thread principal réutilise ce même code avec un `set` inerte pour
 * retrouver la position et la nature des coffres, et donc leur butin.
 */

import { SEA_LEVEL, WORLD_HEIGHT } from '../core/constants';
import { B } from './blocks';
import { Biome } from './biomes';
import { mulberry32 } from './noise';

export type LootKind = 'village' | 'shipwreck' | 'portal' | 'treasure' | 'mineshaft' | 'fortress';
/** Où une structure a le droit d'exister. */
export type StructRealm = 'overworld' | 'nether';

/** Ce dont un bâtisseur a besoin : lire le terrain, écrire des blocs. */
export interface StructCtx {
  seed: number;
  heightAt(x: number, z: number): number;
  biomeAt(x: number, z: number, height?: number): Biome;
  /** Pose un bloc ; `force` écrase ce qui s'y trouve déjà. */
  set(x: number, y: number, z: number, id: number, force?: boolean): void;
  /** Lit un bloc, ou -1 s'il est hors du chunk courant. */
  get(x: number, y: number, z: number): number;
  /** Signale un coffre de butin (le contenu est tiré par le thread principal). */
  chest(x: number, y: number, z: number, kind: LootKind): void;
}

export interface Anchor {
  x: number;
  z: number;
  y: number;
  /** Graine locale : deux structures voisines ne se ressemblent pas. */
  salt: number;
}

// Espacements en blocs. Le village est le plus dense — c'est la demande.
export const VILLAGE_SPACING = 100;
const SHIPWRECK_SPACING = 128;
const PORTAL_SPACING = 192;
const TREASURE_SPACING = 112;
const MINESHAFT_SPACING = 144;
const FORTRESS_SPACING = 176;

/** Rayon d'emprise, utilisé pour savoir quelles cellules concernent un chunk. */
const VILLAGE_RADIUS = 30;
const SHIPWRECK_RADIUS = 10;
const PORTAL_RADIUS = 9;
const TREASURE_RADIUS = 3;
const MINESHAFT_RADIUS = 42;
const FORTRESS_RADIUS = 34;

/** Hachage entier stable : même valeur dans le worker et sur le thread principal. */
function hashCell(seed: number, gx: number, gz: number, salt: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (gx + 0x7ed55d16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (gz + 0x165667b1), 0xc2b2ae35) >>> 0;
  h = Math.imul(h ^ salt, 0x27d4eb2f) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

// ---------------------------------------------------------------------------
// Sélection des sites
// ---------------------------------------------------------------------------

const VILLAGE_BIOMES = new Set<Biome>([
  Biome.Plains, Biome.SunflowerPlains, Biome.Meadow, Biome.Savanna,
  Biome.Forest, Biome.BirchForest, Biome.Taiga, Biome.Desert,
]);

/**
 * Village de la cellule `(gx, gz)`, ou `null` si le site ne convient pas
 * (océan, montagne, terrain trop accidenté).
 */
export function villageAt(ctx: StructCtx, gx: number, gz: number): Anchor | null {
  const h0 = hashCell(ctx.seed, gx, gz, 101);
  // Une cellule sur cinq reste vide : un semis parfaitement régulier se voit.
  if (h0 % 100 < 18) return null;
  const jx = 18 + ((h0 >>> 7) % (VILLAGE_SPACING - 36));
  const jz = 18 + ((h0 >>> 17) % (VILLAGE_SPACING - 36));
  const x = gx * VILLAGE_SPACING + jx;
  const z = gz * VILLAGE_SPACING + jz;

  const y = ctx.heightAt(x, z);
  if (y < SEA_LEVEL + 1 || y > SEA_LEVEL + 26) return null;
  if (!VILLAGE_BIOMES.has(ctx.biomeAt(x, z, y))) return null;

  // Terrain assez plat : on échantillonne une croix de 20 blocs de côté.
  let lo = y, hi = y;
  for (const [dx, dz] of [[-14, 0], [14, 0], [0, -14], [0, 14], [-10, -10], [10, 10], [-10, 10], [10, -10]] as const) {
    const s = ctx.heightAt(x + dx, z + dz);
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  if (hi - lo > 6) return null;

  return { x, z, y, salt: h0 };
}

/** Épave posée sur un fond marin. */
export function shipwreckAt(ctx: StructCtx, gx: number, gz: number): Anchor | null {
  const h0 = hashCell(ctx.seed, gx, gz, 211);
  if (h0 % 100 < 22) return null;
  const x = gx * SHIPWRECK_SPACING + 14 + ((h0 >>> 7) % (SHIPWRECK_SPACING - 28));
  const z = gz * SHIPWRECK_SPACING + 14 + ((h0 >>> 17) % (SHIPWRECK_SPACING - 28));
  const y = ctx.heightAt(x, z);
  if (y > SEA_LEVEL - 5 || y < 12) return null;
  // Fond régulier : une épave à cheval sur une falaise sous-marine se coupe en deux.
  for (const [dx, dz] of [[-6, 0], [6, 0], [0, -4], [0, 4]] as const) {
    if (Math.abs(ctx.heightAt(x + dx, z + dz) - y) > 3) return null;
  }
  return { x, z, y, salt: h0 };
}

/** Portail englouti : cadre d'obsidienne rongé, dressé au fond de l'eau. */
export function portalAt(ctx: StructCtx, gx: number, gz: number): Anchor | null {
  const h0 = hashCell(ctx.seed, gx, gz, 307);
  if (h0 % 100 < 30) return null;
  const x = gx * PORTAL_SPACING + 12 + ((h0 >>> 7) % (PORTAL_SPACING - 24));
  const z = gz * PORTAL_SPACING + 12 + ((h0 >>> 17) % (PORTAL_SPACING - 24));
  const y = ctx.heightAt(x, z);
  if (y > SEA_LEVEL - 8 || y < 10) return null;
  for (const [dx, dz] of [[-5, 0], [5, 0], [0, -5], [0, 5]] as const) {
    if (Math.abs(ctx.heightAt(x + dx, z + dz) - y) > 3) return null;
  }
  return { x, z, y, salt: h0 };
}

/** Coffre au trésor enterré sous une plage ou un haut-fond. */
export function treasureAt(ctx: StructCtx, gx: number, gz: number): Anchor | null {
  const h0 = hashCell(ctx.seed, gx, gz, 409);
  if (h0 % 100 < 25) return null;
  const x = gx * TREASURE_SPACING + 8 + ((h0 >>> 7) % (TREASURE_SPACING - 16));
  const z = gz * TREASURE_SPACING + 8 + ((h0 >>> 17) % (TREASURE_SPACING - 16));
  const y = ctx.heightAt(x, z);
  if (y < SEA_LEVEL - 7 || y > SEA_LEVEL + 3) return null;
  const b = ctx.biomeAt(x, z, y);
  if (b !== Biome.Beach && b !== Biome.Ocean && b !== Biome.Desert) return null;
  return { x, z, y, salt: h0 };
}

// ---------------------------------------------------------------------------
// Émission
// ---------------------------------------------------------------------------

interface Kindled {
  realm: StructRealm;
  spacing: number;
  radius: number;
  pick: (ctx: StructCtx, gx: number, gz: number) => Anchor | null;
  build: (ctx: StructCtx, a: Anchor) => void;
}

const KINDS: Kindled[] = [
  { realm: 'overworld', spacing: VILLAGE_SPACING, radius: VILLAGE_RADIUS, pick: villageAt, build: buildVillage },
  { realm: 'overworld', spacing: SHIPWRECK_SPACING, radius: SHIPWRECK_RADIUS, pick: shipwreckAt, build: buildShipwreck },
  { realm: 'overworld', spacing: PORTAL_SPACING, radius: PORTAL_RADIUS, pick: portalAt, build: buildSunkenPortal },
  { realm: 'overworld', spacing: TREASURE_SPACING, radius: TREASURE_RADIUS, pick: treasureAt, build: buildTreasure },
  { realm: 'overworld', spacing: MINESHAFT_SPACING, radius: MINESHAFT_RADIUS, pick: mineshaftAt, build: buildMineshaft },
  { realm: 'nether', spacing: FORTRESS_SPACING, radius: FORTRESS_RADIUS, pick: fortressAt, build: buildFortress },
];

/**
 * Construit toutes les structures dont l'emprise recoupe la boîte
 * `[minX, maxX] × [minZ, maxZ]`. Le `set` du contexte se charge du découpage.
 */
export function emitStructures(ctx: StructCtx, minX: number, minZ: number, maxX: number, maxZ: number, realm: StructRealm = 'overworld'): void {
  for (const k of KINDS) {
    if (k.realm !== realm) continue;
    const g0x = floorDiv(minX - k.radius, k.spacing);
    const g1x = floorDiv(maxX + k.radius, k.spacing);
    const g0z = floorDiv(minZ - k.radius, k.spacing);
    const g1z = floorDiv(maxZ + k.radius, k.spacing);
    for (let gz = g0z; gz <= g1z; gz++) {
      for (let gx = g0x; gx <= g1x; gx++) {
        const a = k.pick(ctx, gx, gz);
        if (!a) continue;
        if (a.x + k.radius < minX || a.x - k.radius > maxX) continue;
        if (a.z + k.radius < minZ || a.z - k.radius > maxZ) continue;
        k.build(ctx, a);
      }
    }
  }
}

/** Villages dont le centre est à moins de `radius` blocs : sert au peuplement. */
export function villagesNear(ctx: StructCtx, x: number, z: number, radius: number): Anchor[] {
  const out: Anchor[] = [];
  const g0x = floorDiv(x - radius, VILLAGE_SPACING);
  const g1x = floorDiv(x + radius, VILLAGE_SPACING);
  const g0z = floorDiv(z - radius, VILLAGE_SPACING);
  const g1z = floorDiv(z + radius, VILLAGE_SPACING);
  for (let gz = g0z; gz <= g1z; gz++) {
    for (let gx = g0x; gx <= g1x; gx++) {
      const a = villageAt(ctx, gx, gz);
      if (!a) continue;
      if (Math.hypot(a.x - x, a.z - z) <= radius) out.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Village
// ---------------------------------------------------------------------------

interface Palette {
  wall: number;
  wood: number;
  log: number;
  roof: number;
  floor: number;
  path: number;
}

function palette(ctx: StructCtx, a: Anchor): Palette {
  const b = ctx.biomeAt(a.x, a.z, a.y);
  if (b === Biome.Desert) {
    return { wall: B.sandstone, wood: B.sandstone, log: B.sandstone, roof: B.stone_bricks, floor: B.sandstone, path: B.sand };
  }
  if (b === Biome.Taiga || b === Biome.SnowyTaiga) {
    return { wall: B.spruce_planks, wood: B.spruce_planks, log: B.spruce_log, roof: B.stone_bricks, floor: B.cobblestone, path: B.gravel };
  }
  if (b === Biome.BirchForest) {
    return { wall: B.birch_planks, wood: B.birch_planks, log: B.birch_log, roof: B.bricks, floor: B.cobblestone, path: B.gravel };
  }
  return { wall: B.oak_planks, wood: B.oak_planks, log: B.oak_log, roof: B.bricks, floor: B.cobblestone, path: B.gravel };
}

/**
 * Un village : un puits central, cinq à huit maisons réparties en couronne,
 * des sentiers, des lampadaires et — la demande explicite — un **champ de
 * citrouilles** attenant.
 */
function buildVillage(ctx: StructCtx, a: Anchor): void {
  const rnd = mulberry32(a.salt ^ 0x51ed270b);
  const pal = palette(ctx, a);
  const base = a.y;

  clearVegetation(ctx, a.x, a.z, VILLAGE_RADIUS - 4);

  // Place centrale et puits.
  for (let dz = -4; dz <= 4; dz++) {
    for (let dx = -4; dx <= 4; dx++) {
      if (dx * dx + dz * dz > 20) continue;
      column(ctx, a.x + dx, a.z + dz, base, pal.path);
    }
  }
  buildWell(ctx, a.x, base, a.z, pal);

  const count = 5 + Math.floor(rnd() * 4);
  const placed: { x: number; z: number }[] = [];
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rnd() * 0.5;
    const dist = 11 + rnd() * 11;
    const hx = a.x + Math.round(Math.cos(ang) * dist);
    const hz = a.z + Math.round(Math.sin(ang) * dist);
    if (placed.some((p) => Math.abs(p.x - hx) < 8 && Math.abs(p.z - hz) < 8)) continue;
    placed.push({ x: hx, z: hz });
    const w = 5 + (rnd() < 0.4 ? 2 : 0);
    const d = 5 + (rnd() < 0.4 ? 2 : 0);
    buildHouse(ctx, hx, base, hz, w, d, pal, rnd, a.salt + i);
    pathTo(ctx, a.x, a.z, hx, hz, base, pal.path);
    if (rnd() < 0.45) lampPost(ctx, hx + (rnd() < 0.5 ? -1 : 1) * (w + 1), base, hz, pal);
  }

  // Champ de citrouilles : la parcelle du village, toujours du même côté que
  // l'entrée principale pour rester lisible depuis la place.
  const fx = a.x + (a.salt & 1 ? 1 : -1) * 14;
  const fz = a.z + (a.salt & 2 ? 1 : -1) * 12;
  buildPumpkinFarm(ctx, fx, base, fz, rnd);
}

/**
 * Abat ce qui pousse dans l'emprise d'un village : troncs, feuillages, hautes
 * herbes. Un village de taïga naissait sinon au milieu des sapins, troncs au
 * travers des murs et bouquets de feuilles suspendus au-dessus des toits une
 * fois les colonnes nivelées.
 *
 * On lit avant d'écrire : hors du chunk courant `get` renvoie -1, et c'est au
 * chunk voisin de traiter ses propres colonnes.
 */
function clearVegetation(ctx: StructCtx, cx: number, cz: number, radius: number): void {
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dz * dz > radius * radius) continue;
      const x = cx + dx;
      const z = cz + dz;
      const g = ctx.heightAt(x, z);
      for (let y = g + 1; y <= g + 26 && y < WORLD_HEIGHT; y++) {
        if (ctx.get(x, y, z) > 0) ctx.set(x, y, z, 0, true);
      }
    }
  }
}

/**
 * Nivelle une colonne : remblai jusqu'au sol, dégagement au-dessus. Le
 * dégagement monte assez haut pour emporter un arbre entier — la décoration
 * passe avant les structures, un chêne peut très bien pousser sur la place.
 */
function column(ctx: StructCtx, x: number, z: number, y: number, ground: number): void {
  const g = ctx.heightAt(x, z);
  for (let yy = Math.min(g, y - 1); yy <= y; yy++) ctx.set(x, yy, z, yy === y ? ground : B.dirt, true);
  for (let yy = y + 1; yy <= y + 12; yy++) ctx.set(x, yy, z, 0, true);
}

function buildWell(ctx: StructCtx, x: number, y: number, z: number, pal: Palette): void {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const edge = dx !== 0 || dz !== 0;
      for (let dy = 0; dy <= 1; dy++) {
        ctx.set(x + dx, y + dy, z + dz, edge ? B.cobblestone : dy === 0 ? B.water : 0, true);
      }
    }
  }
  // Margelle et toit sur quatre piliers.
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    for (let dy = 2; dy <= 4; dy++) ctx.set(x + dx, y + dy, z + dz, pal.log, true);
  }
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) ctx.set(x + dx, y + 5, z + dz, pal.wood, true);
  }
  // La nappe descend sous la margelle : le puits a un fond.
  for (let dy = -1; dy >= -4; dy--) ctx.set(x, y + dy, z, B.water, true);
}

/**
 * Maison : fondation en pierre, murs de planches avec poteaux d'angle, deux
 * fenêtres, une porte ouverte, toit en pente et mobilier (coffre, établi,
 * torche).
 */
function buildHouse(
  ctx: StructCtx,
  cx: number,
  y: number,
  cz: number,
  w: number,
  d: number,
  pal: Palette,
  rnd: () => number,
  salt: number,
): void {
  const hw = w >> 1;
  const hd = d >> 1;
  const height = 4;

  // Terrassement : le sol de la maison est plat, les fondations comblent la pente.
  for (let dz = -hd - 1; dz <= hd + 1; dz++) {
    for (let dx = -hw - 1; dx <= hw + 1; dx++) {
      const x = cx + dx, z = cz + dz;
      const g = ctx.heightAt(x, z);
      for (let yy = Math.min(g, y - 1); yy < y; yy++) ctx.set(x, yy, z, B.cobblestone, true);
      ctx.set(x, y, z, pal.floor, true);
      for (let yy = y + 1; yy <= y + height + 10; yy++) ctx.set(x, yy, z, 0, true);
    }
  }

  const doorSide = salt % 4;
  for (let dy = 1; dy <= height; dy++) {
    for (let dz = -hd; dz <= hd; dz++) {
      for (let dx = -hw; dx <= hw; dx++) {
        const onX = Math.abs(dx) === hw;
        const onZ = Math.abs(dz) === hd;
        if (!onX && !onZ) continue;
        const corner = onX && onZ;
        let block = corner ? pal.log : pal.wall;
        // Fenêtres à mi-hauteur, une case sur deux.
        if (!corner && dy === 2 && ((dx + dz) & 1) === 0) block = B.glass;
        // Porte : une ouverture de deux blocs au milieu d'une façade.
        const atDoor =
          (doorSide === 0 && dz === -hd && dx === 0) ||
          (doorSide === 1 && dz === hd && dx === 0) ||
          (doorSide === 2 && dx === -hw && dz === 0) ||
          (doorSide === 3 && dx === hw && dz === 0);
        if (atDoor && dy <= 2) block = 0;
        ctx.set(cx + dx, y + dy, cz + dz, block, true);
      }
    }
  }

  // Plafond plein, débordant d'un bloc. C'est lui qui ferme la maison : la
  // version en anneaux laissait un jour continu tout autour du bâtiment, entre
  // le haut des murs et l'avant-toit posé un cran plus haut et plus large.
  const eave = y + height + 1;
  for (let dz = -hd - 1; dz <= hd + 1; dz++) {
    for (let dx = -hw - 1; dx <= hw + 1; dx++) ctx.set(cx + dx, eave, cz + dz, pal.wood, true);
  }

  // Toiture en gradins pleins, refermée d'elle-même au faîte.
  for (let step = 1; ; step++) {
    const rx = hw + 1 - step;
    const rz = hd + 1 - step;
    if (rx < 0 || rz < 0) break;
    for (let dz = -rz; dz <= rz; dz++) {
      for (let dx = -rx; dx <= rx; dx++) ctx.set(cx + dx, eave + step, cz + dz, pal.roof, true);
    }
  }

  // Mobilier contre un mur.
  const ix = cx + (hw - 1) * (salt & 1 ? 1 : -1);
  const iz = cz + (hd - 1) * (salt & 2 ? 1 : -1);
  ctx.set(ix, y + 1, iz, B.chest, true);
  ctx.chest(ix, y + 1, iz, 'village');
  ctx.set(cx - (hw - 1), y + 1, cz + (hd - 1), rnd() < 0.5 ? B.crafting_table : B.furnace, true);
  // Torche posée au sol dans un angle : faute de torche murale, une torche
  // suspendue au milieu du plafond avait l'air d'un oubli.
  ctx.set(cx - (hw - 1), y + 1, cz - (hd - 1), B.torch, true);
  if (rnd() < 0.3) ctx.set(cx + (hw - 1), y + 1, cz - (hd - 1), B.bookshelf, true);
}

/** Sentier de gravier reliant deux points, en escalier sur le relief. */
function pathTo(ctx: StructCtx, x0: number, z0: number, x1: number, z1: number, y: number, mat: number): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const z = Math.round(z0 + (z1 - z0) * t);
    column(ctx, x, z, y, mat);
    column(ctx, x + 1, z, y, mat);
  }
}

function lampPost(ctx: StructCtx, x: number, y: number, z: number, pal: Palette): void {
  column(ctx, x, z, y, pal.path);
  for (let dy = 1; dy <= 3; dy++) ctx.set(x, y + dy, z, pal.log, true);
  ctx.set(x, y + 4, z, B.glowstone, true);
}

/**
 * Champ de citrouilles clôturé : terre labourée, rangées de citrouilles et
 * quelques pieds de blé. C'est le repère du village vu de loin.
 */
function buildPumpkinFarm(ctx: StructCtx, cx: number, y: number, cz: number, rnd: () => number): void {
  const w = 4, d = 5;
  for (let dz = -d; dz <= d; dz++) {
    for (let dx = -w; dx <= w; dx++) {
      const x = cx + dx, z = cz + dz;
      const border = Math.abs(dx) === w || Math.abs(dz) === d;
      column(ctx, x, z, y, border ? B.coarse_dirt : B.dirt);
      if (border) {
        // Muret bas : la parcelle se lit comme un enclos.
        ctx.set(x, y + 1, z, B.cobblestone_slab, true);
        continue;
      }
      const r = rnd();
      if (((dx + dz) & 1) === 0 && r < 0.7) ctx.set(x, y + 1, z, B.pumpkin, true);
      else if (r < 0.85) ctx.set(x, y + 1, z, B.wheat, true);
    }
  }
  // Une lanterne-citrouille marque l'entrée du champ.
  ctx.set(cx, y + 1, cz - d, B.jack_o_lantern, true);
}

// ---------------------------------------------------------------------------
// Épave
// ---------------------------------------------------------------------------

/** Coque de sapin échouée, éventrée, avec deux coffres de cale. */
function buildShipwreck(ctx: StructCtx, a: Anchor): void {
  const rnd = mulberry32(a.salt ^ 0x2f1c3a7d);
  const along = (a.salt & 1) === 0; // orientée sur X ou sur Z
  const len = 9, wid = 3, hull = 4;
  const tilt = (a.salt >>> 3) % 3; // l'épave s'enfonce d'un côté

  const put = (u: number, v: number, dy: number, id: number) => {
    const x = along ? a.x + u : a.x + v;
    const z = along ? a.z + v : a.z + u;
    // Les planches percées laissent voir la cale. Le vide se remplit d'eau :
    // une poche d'air à vingt mètres de fond n'aurait aucun sens.
    if (id !== 0 && rnd() < 0.12) id = 0;
    ctx.set(x, a.y + dy, z, id === 0 ? B.water : id, true);
  };

  for (let u = -len; u <= len; u++) {
    // Proue et poupe se resserrent.
    const narrow = Math.abs(u) > len - 3 ? 1 : 0;
    const sink = tilt === 0 ? 0 : Math.round(((u + len) / (2 * len)) * tilt);
    for (let v = -wid + narrow; v <= wid - narrow; v++) {
      // Quille : on creuse le fond marin pour asseoir la coque.
      for (let dy = -2 + sink; dy <= hull + sink; dy++) {
        const shell = Math.abs(v) === wid - narrow || dy === -2 + sink || Math.abs(u) === len;
        put(u, v, dy, shell ? B.spruce_planks : 0);
      }
      // Pont partiel : la moitié arrière est encore couverte.
      if (u < 2) put(u, v, hull + sink, rnd() < 0.7 ? B.spruce_slab : B.water);
    }
  }

  // Mât brisé.
  const mastH = 4 + Math.floor(rnd() * 4);
  for (let i = 1; i <= mastH; i++) put(2, 0, hull + i, B.spruce_log);

  // Cale : deux coffres, plus quelques barils suggérés par des blocs de bois.
  for (const [u, v] of [[-5, 0], [5, 0]] as const) {
    const x = along ? a.x + u : a.x + v;
    const z = along ? a.z + v : a.z + u;
    const y = a.y + (tilt === 0 ? 0 : Math.round(((u + len) / (2 * len)) * tilt)) - 1;
    ctx.set(x, y, z, B.chest, true);
    ctx.chest(x, y, z, 'shipwreck');
  }

  // Sable accumulé contre la coque.
  for (let i = 0; i < 26; i++) {
    const u = Math.floor(rnd() * (2 * len + 1)) - len;
    const v = (rnd() < 0.5 ? -1 : 1) * (wid + 1);
    put(u, v, -2, B.sand);
  }
}

// ---------------------------------------------------------------------------
// Portail englouti
// ---------------------------------------------------------------------------

/**
 * Cadre d'obsidienne dressé sur une plate-forme de pierre sculptée, rongé par
 * le sel : quelques blocs manquent, d'autres sont fissurés.
 */
function buildSunkenPortal(ctx: StructCtx, a: Anchor): void {
  const rnd = mulberry32(a.salt ^ 0x7b3d19c5);
  const along = (a.salt & 1) === 0;
  const w = 4, h = 5;

  const put = (u: number, dy: number, v: number, id: number, force = true) => {
    const x = along ? a.x + u : a.x + v;
    const z = along ? a.z + v : a.z + u;
    ctx.set(x, a.y + dy, z, id, force);
  };

  // Socle et dégagement.
  for (let v = -3; v <= 3; v++) {
    for (let u = -4; u <= 4; u++) {
      const r = rnd();
      put(u, 0, v, r < 0.45 ? B.stone_bricks : r < 0.75 ? B.cracked_stone_bricks : B.mossy_cobblestone);
      for (let dy = 1; dy <= h + 2; dy++) put(u, dy, v, B.water);
    }
  }

  // Cadre : montants, linteau et seuil.
  for (let dy = 1; dy <= h; dy++) {
    for (let u = -Math.floor(w / 2); u <= Math.floor(w / 2); u++) {
      const frame = dy === 1 || dy === h || Math.abs(u) === Math.floor(w / 2);
      if (!frame) continue;
      // Une pierre sur six a cédé : le portail est mort depuis longtemps.
      put(u, dy, 0, rnd() < 0.17 ? B.water : B.obsidian);
    }
  }

  // Lueur résiduelle et végétation marine autour.
  put(0, 1, 0, B.sea_lantern);
  for (let i = 0; i < 10; i++) {
    const u = Math.floor(rnd() * 9) - 4;
    const v = Math.floor(rnd() * 7) - 3;
    if (u === 0 && v === 0) continue;
    put(u, 1, v, rnd() < 0.5 ? B.prismarine : B.dark_prismarine);
  }

  // Coffre du gardien, adossé au socle.
  const cu = 3, cv = 2;
  const cxw = along ? a.x + cu : a.x + cv;
  const czw = along ? a.z + cv : a.z + cu;
  ctx.set(cxw, a.y + 1, czw, B.chest, true);
  ctx.chest(cxw, a.y + 1, czw, 'portal');
}

// ---------------------------------------------------------------------------
// Coffre au trésor
// ---------------------------------------------------------------------------

/** Coffre enfoui sous deux à quatre blocs de sable, sans aucun repère visible. */
function buildTreasure(ctx: StructCtx, a: Anchor): void {
  const rnd = mulberry32(a.salt ^ 0x1de3a97f);
  const depth = 2 + Math.floor(rnd() * 3);
  const y = Math.max(2, Math.min(WORLD_HEIGHT - 2, a.y - depth));
  // Petite alcôve de pierre : le coffre ne flotte pas dans le sable.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      ctx.set(a.x + dx, y - 1, a.z + dz, B.stone_bricks, true);
      if (dx !== 0 || dz !== 0) ctx.set(a.x + dx, y, a.z + dz, B.sand, true);
    }
  }
  ctx.set(a.x, y, a.z, B.chest, true);
  ctx.chest(a.x, y, a.z, 'treasure');
}

// ---------------------------------------------------------------------------
// Mine abandonnée
// ---------------------------------------------------------------------------

/**
 * Mine abandonnée : un réseau de galeries étayées, creusé sous terre. Le site
 * est valide dès que le terrain est assez haut pour loger le niveau de la mine.
 */
export function mineshaftAt(ctx: StructCtx, gx: number, gz: number): Anchor | null {
  const h0 = hashCell(ctx.seed, gx, gz, 523);
  if (h0 % 100 < 24) return null;
  const x = gx * MINESHAFT_SPACING + 24 + ((h0 >>> 7) % (MINESHAFT_SPACING - 48));
  const z = gz * MINESHAFT_SPACING + 24 + ((h0 >>> 17) % (MINESHAFT_SPACING - 48));
  const surface = ctx.heightAt(x, z);
  if (surface < SEA_LEVEL - 2) return null;
  // La mine s'installe entre 14 et 40, sous la couche de surface.
  const y = 14 + (h0 >>> 23) % 22;
  if (y > surface - 12) return null;
  return { x, z, y, salt: h0 };
}

/**
 * Galeries en croix, sur deux niveaux reliés par un puits. Chaque galerie est
 * étayée tous les cinq blocs, éclairée à la torche, et débouche parfois sur une
 * salle plus large avec un coffre.
 */
function buildMineshaft(ctx: StructCtx, a: Anchor): void {
  const rnd = mulberry32(a.salt ^ 0x3ac91f5b);

  /** Creuse une galerie de 3 de large et 3 de haut, étayée. */
  const gallery = (x0: number, z0: number, y: number, dx: number, dz: number, len: number) => {
    for (let i = 0; i < len; i++) {
      const x = x0 + dx * i;
      const z = z0 + dz * i;
      // Section : on évide, puis on pose un plancher de planches.
      for (let dy = 0; dy <= 2; dy++) {
        for (let w = -1; w <= 1; w++) {
          const px = x + (dz ? w : 0);
          const pz = z + (dx ? w : 0);
          ctx.set(px, y + dy, pz, 0, true);
        }
      }
      for (let w = -1; w <= 1; w++) {
        ctx.set(x + (dz ? w : 0), y - 1, z + (dx ? w : 0), rnd() < 0.75 ? B.oak_planks : B.gravel, true);
      }
      // Étai : deux poteaux et une poutre, tous les cinq blocs.
      if (i % 5 === 0) {
        for (const w of [-1, 1]) {
          const px = x + (dz ? w : 0);
          const pz = z + (dx ? w : 0);
          for (let dy = 0; dy <= 2; dy++) ctx.set(px, y + dy, pz, B.oak_log, true);
        }
        for (let w = -1; w <= 1; w++) ctx.set(x + (dz ? w : 0), y + 3, z + (dx ? w : 0), B.oak_planks, true);
        if (rnd() < 0.5) ctx.set(x, y + 2, z, B.torch, true);
      }
      // Éboulements et filons exposés : la galerie n'est pas un couloir propre.
      if (rnd() < 0.06) ctx.set(x, y, z, B.gravel, true);
      if (rnd() < 0.05) {
        const ore = rnd() < 0.5 ? B.iron_ore : rnd() < 0.6 ? B.coal_ore : rnd() < 0.8 ? B.gold_ore : B.diamond_ore;
        ctx.set(x + (dz ? 2 : 0), y + 1, z + (dx ? 2 : 0), ore, true);
      }
    }
  };

  const levels = [a.y, a.y + 7];
  for (let li = 0; li < levels.length; li++) {
    const y = levels[li];
    if (y < 6 || y > WORLD_HEIGHT - 8) continue;
    // Deux galeries principales en croix, plus des embranchements.
    gallery(a.x - 26, a.z, y, 1, 0, 52);
    gallery(a.x, a.z - 26, y, 0, 1, 52);
    const branches = 2 + Math.floor(rnd() * 3);
    for (let b = 0; b < branches; b++) {
      const along = rnd() < 0.5;
      const off = Math.floor((rnd() - 0.5) * 40);
      const len = 12 + Math.floor(rnd() * 16);
      if (along) gallery(a.x + off, a.z - (len >> 1), y, 0, 1, len);
      else gallery(a.x - (len >> 1), a.z + off, y, 1, 0, len);
    }
    // Salle du dépôt : un coffre et un établi, au croisement.
    const cx = a.x + (li === 0 ? -4 : 4);
    const cz = a.z + (li === 0 ? 4 : -4);
    for (let dy = 0; dy <= 3; dy++)
      for (let dz = -3; dz <= 3; dz++)
        for (let dx = -3; dx <= 3; dx++) ctx.set(cx + dx, y + dy, cz + dz, 0, true);
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++) ctx.set(cx + dx, y - 1, cz + dz, B.oak_planks, true);
    ctx.set(cx + 2, y, cz + 2, B.chest, true);
    ctx.chest(cx + 2, y, cz + 2, 'mineshaft');
    ctx.set(cx - 2, y, cz - 2, B.crafting_table, true);
    ctx.set(cx, y + 3, cz, B.torch, true);
  }

  // Puits vertical reliant les deux niveaux, avec une échelle suggérée en poteaux.
  for (let y = a.y; y <= a.y + 9; y++) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) ctx.set(a.x + dx, y, a.z + dz, 0, true);
    ctx.set(a.x + 1, y, a.z, B.oak_log, true);
  }
}

// ---------------------------------------------------------------------------
// Forteresse du Nether
// ---------------------------------------------------------------------------

/** Altitude fixe des forteresses : le relief du Nether n'a pas de « surface ». */
const FORTRESS_Y = 48;

export function fortressAt(ctx: StructCtx, gx: number, gz: number): Anchor | null {
  const h0 = hashCell(ctx.seed, gx, gz, 631);
  if (h0 % 100 < 20) return null;
  const x = gx * FORTRESS_SPACING + 30 + ((h0 >>> 7) % (FORTRESS_SPACING - 60));
  const z = gz * FORTRESS_SPACING + 30 + ((h0 >>> 17) % (FORTRESS_SPACING - 60));
  return { x, z, y: FORTRESS_Y, salt: h0 };
}

/**
 * Forteresse : un pont central en briques du Nether, deux tours, une salle des
 * braises et — le bout de la chaîne — la **salle du portail de l'End**, dont
 * les douze cadres attendent d'être garnis d'yeux.
 */
function buildFortress(ctx: StructCtx, a: Anchor): void {
  const rnd = mulberry32(a.salt ^ 0x5c1de3a9);
  const y = a.y;

  /** Boîte pleine, puis évidée : la forteresse s'impose au terrain. */
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number) => {
    for (let z = z0; z <= z1; z++)
      for (let yy = y0; yy <= y1; yy++)
        for (let x = x0; x <= x1; x++) ctx.set(x, yy, z, id, true);
  };
  /** Coque : parois pleines, intérieur dégagé. */
  const room = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    box(x0, y0, z0, x1, y1, z1, B.nether_bricks);
    box(x0 + 1, y0 + 1, z0 + 1, x1 - 1, y1 - 1, z1 - 1, 0);
  };

  // Pont principal est-ouest, avec ses arches et son garde-corps.
  box(a.x - 24, y, a.z - 2, a.x + 24, y, a.z + 2, B.nether_bricks);
  box(a.x - 24, y + 1, a.z - 2, a.x + 24, y + 4, a.z + 2, 0);
  for (let x = a.x - 24; x <= a.x + 24; x++) {
    ctx.set(x, y + 1, a.z - 2, B.nether_bricks, true);
    ctx.set(x, y + 1, a.z + 2, B.nether_bricks, true);
    // Piles descendantes tous les huit blocs : le pont ne flotte pas.
    if ((x - a.x) % 8 === 0) {
      for (let dy = 1; dy <= 14; dy++) {
        ctx.set(x, y - dy, a.z - 2, B.nether_bricks, true);
        ctx.set(x, y - dy, a.z + 2, B.nether_bricks, true);
      }
      for (let dy = 2; dy <= 4; dy++) { ctx.set(x, y + dy, a.z - 2, B.nether_bricks, true); ctx.set(x, y + dy, a.z + 2, B.nether_bricks, true); }
      ctx.set(x, y + 5, a.z, B.nether_bricks, true);
    }
    if ((x - a.x) % 6 === 3) ctx.set(x, y + 1, a.z, B.glowstone, true);
  }

  // Aile nord : salle des braises, gardée par un coffre.
  room(a.x - 7, y, a.z - 16, a.x + 1, y + 6, a.z - 4);
  box(a.x - 3, y, a.z - 4, a.x - 1, y + 3, a.z - 3, 0); // couloir vers le pont
  ctx.set(a.x - 6, y + 1, a.z - 15, B.chest, true);
  ctx.chest(a.x - 6, y + 1, a.z - 15, 'fortress');
  ctx.set(a.x - 3, y + 1, a.z - 10, B.magma_block, true);
  for (let i = 0; i < 8; i++) {
    const bx = a.x - 6 + Math.floor(rnd() * 7);
    const bz = a.z - 15 + Math.floor(rnd() * 11);
    ctx.set(bx, y + 1, bz, rnd() < 0.5 ? B.soul_sand : B.netherrack, true);
  }

  // Aile sud : la salle du portail de l'End.
  buildEndPortalRoom(ctx, a.x - 1, y, a.z + 12, rnd);
  box(a.x - 3, y, a.z + 3, a.x - 1, y + 3, a.z + 6, 0);

  // Deux tours d'angle avec leur coffre.
  for (const [sx, sz] of [[-20, -8], [20, 8]] as const) {
    room(a.x + sx - 3, y - 2, a.z + sz - 3, a.x + sx + 3, y + 9, a.z + sz + 3);
    ctx.set(a.x + sx, y + 8, a.z + sz, B.glowstone, true);
    ctx.set(a.x + sx + 2, y - 1, a.z + sz + 2, B.chest, true);
    ctx.chest(a.x + sx + 2, y - 1, a.z + sz + 2, 'fortress');
    // Passerelle vers le pont.
    const step = sz < 0 ? 1 : -1;
    for (let i = 0; i <= Math.abs(sz); i++) box(a.x + sx, y, a.z + sz + step * i, a.x + sx + 1, y, a.z + sz + step * i, B.nether_bricks);
  }
}

/**
 * Salle du portail de l'End : douze cadres en anneau autour d'un bassin de
 * trois sur trois. Les cadres sont vides — c'est au joueur d'y sertir les yeux.
 */
function buildEndPortalRoom(ctx: StructCtx, cx: number, y: number, cz: number, rnd: () => number): void {
  // Coque de la salle.
  for (let dz = -6; dz <= 6; dz++)
    for (let dy = -1; dy <= 8; dy++)
      for (let dx = -6; dx <= 6; dx++) {
        const shell = Math.abs(dx) === 6 || Math.abs(dz) === 6 || dy === -1 || dy === 8;
        ctx.set(cx + dx, y + dy, cz + dz, shell ? B.nether_bricks : 0, true);
      }
  // Dallage et vasques de lave aux angles : la salle s'éclaire toute seule.
  for (let dz = -5; dz <= 5; dz++)
    for (let dx = -5; dx <= 5; dx++) ctx.set(cx + dx, y - 1, cz + dz, rnd() < 0.2 ? B.cracked_stone_bricks : B.stone_bricks, true);
  for (const [ax, az] of [[-4, -4], [4, -4], [-4, 4], [4, 4]] as const) ctx.set(cx + ax, y, cz + az, B.glowing_obsidian, true);

  // L'anneau : trois cadres par côté, tournés vers le centre.
  for (let d = -1; d <= 1; d++) {
    ctx.set(cx + d, y, cz - 2, B.end_portal_frame, true);
    ctx.set(cx + d, y, cz + 2, B.end_portal_frame, true);
    ctx.set(cx - 2, y, cz + d, B.end_portal_frame, true);
    ctx.set(cx + 2, y, cz + d, B.end_portal_frame, true);
  }
  // Fond du bassin : c'est là que le portail s'ouvrira.
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) ctx.set(cx + dx, y - 1, cz + dz, B.obsidian, true);
}
