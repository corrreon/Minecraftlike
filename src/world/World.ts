/**
 * Modèle de données du monde : stockage des chunks, accès aux blocs en
 * coordonnées absolues et moteur de propagation de lumière (ciel + blocs).
 *
 * La lumière est propagée de façon incrémentale, avec un budget d'opérations
 * par image, afin de ne jamais bloquer la boucle de rendu.
 */

import {
  CHUNK_X,
  CHUNK_Z,
  WORLD_HEIGHT,
  chunkKey,
  floorDiv,
  mod,
  voxelIndex,
} from '../core/constants';
import { EMISSION, IS_OPAQUE, LIGHT_FILTER } from './blocks';
import { Chunk, ChunkState } from './Chunk';
import { PADDED_VOLUME, PX, PZ } from './mesher';

/** File FIFO de nombres avec tête glissante (évite les `Array.splice`). */
class LightQueue {
  data: number[] = [];
  head = 0;

  get size(): number {
    return this.data.length - this.head;
  }

  push3(a: number, b: number, c: number): void {
    this.data.push(a, b, c);
  }

  push4(a: number, b: number, c: number, d: number): void {
    this.data.push(a, b, c, d);
  }

  compact(): void {
    if (this.head === 0) return;
    if (this.head >= this.data.length) {
      this.data.length = 0;
      this.head = 0;
    } else if (this.head > 16384 && this.head * 2 > this.data.length) {
      this.data = this.data.slice(this.head);
      this.head = 0;
    }
  }
}

const NEIGHBORS: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export class World {
  readonly seed: number;
  readonly chunks = new Map<string, Chunk>();
  /** Blocs de structures débordant sur des chunks pas encore générés. */
  readonly overflow = new Map<string, number[]>();
  /** Chunks dont le maillage doit être reconstruit. */
  readonly dirty = new Set<string>();

  // Files de propagation. Un index de tête évite les `splice` coûteux : le
  // tableau n'est compacté que lorsque la partie consommée devient importante.
  private skyAdd = new LightQueue();
  private skyRemove = new LightQueue();
  private blkAdd = new LightQueue();
  private blkRemove = new LightQueue();

  private lastChunk: Chunk | null = null;
  private lastKeyX = NaN;
  private lastKeyZ = NaN;

  private padPool: ArrayBuffer[] = [];

  constructor(seed: number) {
    this.seed = seed;
  }

  // --- Accès aux chunks ---------------------------------------------------

  getChunk(cx: number, cz: number): Chunk | undefined {
    if (cx === this.lastKeyX && cz === this.lastKeyZ && this.lastChunk) return this.lastChunk;
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c) {
      this.lastChunk = c;
      this.lastKeyX = cx;
      this.lastKeyZ = cz;
    }
    return c;
  }

  getOrCreateChunk(cx: number, cz: number): Chunk {
    const k = chunkKey(cx, cz);
    let c = this.chunks.get(k);
    if (!c) {
      c = new Chunk(cx, cz);
      this.chunks.set(k, c);
    }
    return c;
  }

  removeChunk(cx: number, cz: number): void {
    const k = chunkKey(cx, cz);
    this.chunks.delete(k);
    this.dirty.delete(k);
    if (this.lastKeyX === cx && this.lastKeyZ === cz) this.lastChunk = null;
  }

  isLoaded(cx: number, cz: number): boolean {
    const c = this.getChunk(cx, cz);
    return !!c && c.state === ChunkState.Ready;
  }

  // --- Accès aux blocs ----------------------------------------------------

  /** Renvoie l'identifiant de bloc, ou -1 si le chunk n'est pas chargé. */
  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return y < 0 ? 6 : 0;
    const c = this.getChunk(floorDiv(x, CHUNK_X), floorDiv(z, CHUNK_Z));
    if (!c || c.state !== ChunkState.Ready) return -1;
    return c.blocks[voxelIndex(mod(x, CHUNK_X), y, mod(z, CHUNK_Z))];
  }

  /** Variante « sûre » : les chunks manquants sont traités comme de la roche. */
  getBlockSolid(x: number, y: number, z: number): number {
    const b = this.getBlock(x, y, z);
    return b < 0 ? 1 : b;
  }

  getLight(x: number, y: number, z: number): number {
    if (y < 0) return 0;
    if (y >= WORLD_HEIGHT) return 0xf0;
    const c = this.getChunk(floorDiv(x, CHUNK_X), floorDiv(z, CHUNK_Z));
    if (!c) return 0;
    return c.light[voxelIndex(mod(x, CHUNK_X), y, mod(z, CHUNK_Z))];
  }

  getSkyLight(x: number, y: number, z: number): number {
    return this.getLight(x, y, z) >> 4;
  }
  getBlockLight(x: number, y: number, z: number): number {
    return this.getLight(x, y, z) & 15;
  }

  private setSkyLight(x: number, y: number, z: number, v: number): void {
    const c = this.getChunk(floorDiv(x, CHUNK_X), floorDiv(z, CHUNK_Z));
    if (!c) return;
    const i = voxelIndex(mod(x, CHUNK_X), y, mod(z, CHUNK_Z));
    c.light[i] = (c.light[i] & 0x0f) | (v << 4);
    this.touch(c, mod(x, CHUNK_X), mod(z, CHUNK_Z));
  }

  private setBlockLightValue(x: number, y: number, z: number, v: number): void {
    const c = this.getChunk(floorDiv(x, CHUNK_X), floorDiv(z, CHUNK_Z));
    if (!c) return;
    const i = voxelIndex(mod(x, CHUNK_X), y, mod(z, CHUNK_Z));
    c.light[i] = (c.light[i] & 0xf0) | v;
    this.touch(c, mod(x, CHUNK_X), mod(z, CHUNK_Z));
  }

  /**
   * Marque le chunk comme à remailler. Les voisins ne sont pas notifiés
   * immédiatement (trop coûteux en pleine propagation de lumière) : on retient
   * un masque de bords, résolu une fois par image par `flushBorders`.
   */
  private touch(c: Chunk, lx: number, lz: number): void {
    c.rev++;
    this.dirty.add(c.key);
    if (lx === 0) c.borderDirty |= 1;
    else if (lx === CHUNK_X - 1) c.borderDirty |= 2;
    if (lz === 0) c.borderDirty |= 4;
    else if (lz === CHUNK_Z - 1) c.borderDirty |= 8;
  }

  /** Propage les bords modifiés aux chunks voisins. À appeler une fois par image. */
  flushBorders(): void {
    if (this.dirty.size === 0) return;
    const keys = Array.from(this.dirty);
    for (const key of keys) {
      const c = this.chunks.get(key);
      if (!c || !c.borderDirty) continue;
      const m = c.borderDirty;
      c.borderDirty = 0;
      if (m & 1) this.markDirty(c.cx - 1, c.cz);
      if (m & 2) this.markDirty(c.cx + 1, c.cz);
      if (m & 4) this.markDirty(c.cx, c.cz - 1);
      if (m & 8) this.markDirty(c.cx, c.cz + 1);
      if (m & 1 && m & 4) this.markDirty(c.cx - 1, c.cz - 1);
      if (m & 1 && m & 8) this.markDirty(c.cx - 1, c.cz + 1);
      if (m & 2 && m & 4) this.markDirty(c.cx + 1, c.cz - 1);
      if (m & 2 && m & 8) this.markDirty(c.cx + 1, c.cz + 1);
    }
  }

  markDirty(cx: number, cz: number): void {
    const c = this.getChunk(cx, cz);
    if (!c || c.state !== ChunkState.Ready) return;
    c.rev++;
    this.dirty.add(c.key);
  }

  // --- Modification d'un bloc --------------------------------------------

  /**
   * Pose ou retire un bloc et met à jour l'éclairage.
   * @returns true si le monde a effectivement changé.
   */
  setBlock(x: number, y: number, z: number, id: number, record = true): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const cx = floorDiv(x, CHUNK_X);
    const cz = floorDiv(z, CHUNK_Z);
    const c = this.getChunk(cx, cz);
    if (!c || c.state !== ChunkState.Ready) return false;
    const lx = mod(x, CHUNK_X);
    const lz = mod(z, CHUNK_Z);
    const idx = voxelIndex(lx, y, lz);
    const old = c.blocks[idx];
    if (old === id) return false;

    const oldSky = c.light[idx] >> 4;
    const oldBlk = c.light[idx] & 15;

    c.blocks[idx] = id;
    if (record) c.recordEdit(idx, id);
    c.recomputeColumn(lx, lz);
    this.touch(c, lx, lz);

    // --- Lumière de bloc ---
    if (EMISSION[old] > 0) {
      this.setBlockLightValue(x, y, z, 0);
      this.blkRemove.push4(x, y, z, oldBlk);
    } else if (IS_OPAQUE[id] && oldBlk > 0) {
      this.setBlockLightValue(x, y, z, 0);
      this.blkRemove.push4(x, y, z, oldBlk);
    }
    if (EMISSION[id] > 0) {
      this.setBlockLightValue(x, y, z, EMISSION[id]);
      this.blkAdd.push3(x, y, z);
    }
    if (!IS_OPAQUE[id]) {
      // Le voxel est redevenu traversable : les voisins peuvent le rallumer.
      for (const [dx, dy, dz] of NEIGHBORS) {
        if (this.getBlockLight(x + dx, y + dy, z + dz) > 0) this.blkAdd.push3(x + dx, y + dy, z + dz);
      }
    }

    // --- Lumière du ciel ---
    if (IS_OPAQUE[id] || LIGHT_FILTER[id] > LIGHT_FILTER[old]) {
      if (oldSky > 0) {
        this.setSkyLight(x, y, z, 0);
        this.skyRemove.push4(x, y, z, oldSky);
      }
    } else {
      // Ouverture : on relance la propagation depuis les voisins éclairés.
      const above = this.getSkyLight(x, y + 1, z);
      const filter = Math.max(1, LIGHT_FILTER[id]);
      if (above === 15 && LIGHT_FILTER[id] === 0) {
        this.setSkyLight(x, y, z, 15);
        this.skyAdd.push3(x, y, z);
      }
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nl = this.getSkyLight(x + dx, y + dy, z + dz);
        if (nl > 0) {
          const t = nl - filter;
          if (t > this.getSkyLight(x, y, z)) {
            this.setSkyLight(x, y, z, t);
          }
          this.skyAdd.push3(x + dx, y + dy, z + dz);
        }
      }
      if (this.getSkyLight(x, y, z) > 0) this.skyAdd.push3(x, y, z);
    }
    return true;
  }

  /**
   * Écriture brute, sans mise à jour de lumière : réservée aux opérations en
   * masse, où relancer la propagation à chaque bloc coûterait des minutes.
   * Appeler `relight` sur les chunks touchés une fois l'opération terminée.
   */
  setBlockRaw(x: number, y: number, z: number, id: number): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const c = this.getChunk(floorDiv(x, CHUNK_X), floorDiv(z, CHUNK_Z));
    if (!c || c.state !== ChunkState.Ready) return false;
    const lx = mod(x, CHUNK_X);
    const lz = mod(z, CHUNK_Z);
    const idx = voxelIndex(lx, y, lz);
    if (c.blocks[idx] === id) return false;
    c.blocks[idx] = id;
    c.recordEdit(idx, id);
    return true;
  }

  /** Recalcule entièrement l'éclairage d'un chunk et réveille ses voisins. */
  relight(cx: number, cz: number): void {
    const c = this.getChunk(cx, cz);
    if (!c || c.state !== ChunkState.Ready) return;
    c.recomputeHeights();
    this.initChunkLight(c);
    c.rev++;
    this.dirty.add(c.key);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      this.markDirty(cx + dx, cz + dz);
    }
  }

  // --- Initialisation de la lumière d'un chunk ---------------------------

  /** Remplit la lumière du ciel verticalement puis amorce la diffusion. */
  initChunkLight(c: Chunk): void {
    const ox = c.cx * CHUNK_X;
    const oz = c.cz * CHUNK_Z;
    const light = c.light;
    const blocks = c.blocks;
    light.fill(0);

    // Crête locale : hauteur maximale du chunk et de ses voisins déjà chargés.
    let ridge = c.maxHeight;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = this.getChunk(c.cx + dx, c.cz + dz);
      if (n && n.state === ChunkState.Ready) ridge = Math.max(ridge, n.maxHeight);
    }
    const top = Math.min(WORLD_HEIGHT - 1, ridge + 1);

    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        let level = 15;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const i = voxelIndex(lx, y, lz);
          const b = blocks[i];
          if (IS_OPAQUE[b]) {
            level = 0;
          } else {
            const f = LIGHT_FILTER[b];
            if (f > 0) level = Math.max(0, level - f);
          }
          light[i] = level << 4;
          if (level === 0 && y < c.height[lx + lz * CHUNK_X]) {
            // Sous le sol : inutile de continuer, tout est noir.
            for (let yy = y - 1; yy >= 0; yy--) light[voxelIndex(lx, yy, lz)] = 0;
            break;
          }
        }
      }
    }

    // Amorçage : seuls les voxels situés sous la crête locale peuvent diffuser
    // latéralement. Au-dessus, la lumière du ciel vaut 15 partout et la
    // diffusion ne changerait rien : les enfiler coûterait cher pour rien.
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        for (let y = 0; y <= top; y++) {
          const l = light[voxelIndex(lx, y, lz)] >> 4;
          if (l > 0) this.skyAdd.push3(ox + lx, y, oz + lz);
        }
      }
    }

    // Sources lumineuses (torches, lave, pierre lumineuse…).
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let lz = 0; lz < CHUNK_Z; lz++) {
        for (let lx = 0; lx < CHUNK_X; lx++) {
          const i = voxelIndex(lx, y, lz);
          const e = EMISSION[blocks[i]];
          if (e > 0) {
            light[i] = (light[i] & 0xf0) | e;
            this.blkAdd.push3(ox + lx, y, oz + lz);
          }
        }
      }
    }

    // Les bords des chunks voisins déjà chargés doivent réémettre vers nous.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = this.getChunk(c.cx + dx, c.cz + dz);
      if (!n || n.state !== ChunkState.Ready) continue;
      this.reseedBorder(n, dx === 1 ? -1 : dx === -1 ? 1 : 0, dz === 1 ? -1 : dz === -1 ? 1 : 0, top);
      this.dirty.add(n.key);
    }

    c.lit = true;
  }

  /**
   * Réinjecte la bande de bord d'un chunk voisin dans la file de propagation,
   * bornée à la crête locale pour ne pas enfiler tout le ciel dégagé.
   */
  private reseedBorder(n: Chunk, towardX: number, towardZ: number, ridge: number): void {
    const ox = n.cx * CHUNK_X;
    const oz = n.cz * CHUNK_Z;
    const lx0 = towardX === -1 ? CHUNK_X - 1 : 0;
    const lx1 = towardX === 0 ? CHUNK_X - 1 : lx0;
    const lz0 = towardZ === -1 ? CHUNK_Z - 1 : 0;
    const lz1 = towardZ === 0 ? CHUNK_Z - 1 : lz0;
    const top = Math.min(WORLD_HEIGHT - 1, Math.max(ridge, n.maxHeight) + 1);
    for (let lz = lz0; lz <= lz1; lz++) {
      for (let lx = lx0; lx <= lx1; lx++) {
        for (let y = 0; y <= top; y++) {
          const l = n.light[voxelIndex(lx, y, lz)];
          if (l >> 4) this.skyAdd.push3(ox + lx, y, oz + lz);
          if (l & 15) this.blkAdd.push3(ox + lx, y, oz + lz);
        }
      }
    }
  }

  // --- Propagation incrémentale ------------------------------------------

  get lightPending(): number {
    return this.skyAdd.size / 3 + this.skyRemove.size / 4 + this.blkAdd.size / 3 + this.blkRemove.size / 4;
  }

  /** Traite au plus `budget` opérations de lumière. Renvoie le nombre traité. */
  processLighting(budget: number): number {
    let ops = 0;
    ops += this.processRemoval(this.skyRemove, true, budget - ops);
    ops += this.processRemoval(this.blkRemove, false, budget - ops);
    ops += this.processAdd(this.skyAdd, true, budget - ops);
    ops += this.processAdd(this.blkAdd, false, budget - ops);
    return ops;
  }

  private processAdd(queue: LightQueue, sky: boolean, budget: number): number {
    let ops = 0;
    const data = queue.data;
    while (queue.head + 2 < data.length && ops < budget) {
      const head = queue.head;
      const x = data[head], y = data[head + 1], z = data[head + 2];
      queue.head += 3;
      ops++;
      const level = sky ? this.getSkyLight(x, y, z) : this.getBlockLight(x, y, z);
      if (level <= 1) continue;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const nb = this.getBlock(nx, ny, nz);
        if (nb < 0 || IS_OPAQUE[nb]) continue;
        const filter = Math.max(1, LIGHT_FILTER[nb]);
        let target: number;
        if (sky && dy === -1 && level === 15 && LIGHT_FILTER[nb] === 0) target = 15;
        else target = level - filter;
        if (target <= 0) continue;
        const cur = sky ? this.getSkyLight(nx, ny, nz) : this.getBlockLight(nx, ny, nz);
        if (target > cur) {
          if (sky) this.setSkyLight(nx, ny, nz, target);
          else this.setBlockLightValue(nx, ny, nz, target);
          queue.push3(nx, ny, nz);
        }
      }
    }
    queue.compact();
    return ops;
  }

  private processRemoval(queue: LightQueue, sky: boolean, budget: number): number {
    let ops = 0;
    const data = queue.data;
    const addQueue = sky ? this.skyAdd : this.blkAdd;
    while (queue.head + 3 < data.length && ops < budget) {
      const head = queue.head;
      const x = data[head], y = data[head + 1], z = data[head + 2], lvl = data[head + 3];
      queue.head += 4;
      ops++;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const nl = sky ? this.getSkyLight(nx, ny, nz) : this.getBlockLight(nx, ny, nz);
        if (nl === 0) continue;
        const sunColumn = sky && dy === -1 && lvl === 15 && nl === 15;
        if (nl < lvl || sunColumn) {
          if (sky) this.setSkyLight(nx, ny, nz, 0);
          else this.setBlockLightValue(nx, ny, nz, 0);
          queue.push4(nx, ny, nz, nl);
        } else {
          addQueue.push3(nx, ny, nz);
        }
      }
    }
    queue.compact();
    return ops;
  }

  // --- Volume étendu pour le mailleur ------------------------------------

  private takePad(): [Uint8Array, Uint8Array] {
    const a = this.padPool.pop() ?? new ArrayBuffer(PADDED_VOLUME);
    const b = this.padPool.pop() ?? new ArrayBuffer(PADDED_VOLUME);
    return [new Uint8Array(a), new Uint8Array(b)];
  }

  recyclePad(a: ArrayBuffer, b: ArrayBuffer): void {
    if (this.padPool.length < 12) {
      this.padPool.push(a, b);
    }
  }

  /** Copie le chunk et la bordure de ses voisins dans deux volumes 18×128×18. */
  buildPadded(c: Chunk): [Uint8Array, Uint8Array] {
    const [pb, pl] = this.takePad();
    pb.fill(0);
    pl.fill(0);

    // Cœur : copie ligne par ligne (les X sont contigus).
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let lz = 0; lz < CHUNK_Z; lz++) {
        const src = voxelIndex(0, y, lz);
        const dst = 1 + PX * (lz + 1 + PZ * y);
        pb.set(c.blocks.subarray(src, src + CHUNK_X), dst);
        pl.set(c.light.subarray(src, src + CHUNK_X), dst);
      }
    }

    // Bordures : 4 côtés + 4 coins.
    const copyStrip = (dx: number, dz: number) => {
      const n = this.getChunk(c.cx + dx, c.cz + dz);
      const xs = dx === 0 ? [0, CHUNK_X - 1] : dx === 1 ? [0, 0] : [CHUNK_X - 1, CHUNK_X - 1];
      const zs = dz === 0 ? [0, CHUNK_Z - 1] : dz === 1 ? [0, 0] : [CHUNK_Z - 1, CHUNK_Z - 1];
      for (let lz = zs[0]; lz <= zs[1]; lz++) {
        for (let lx = xs[0]; lx <= xs[1]; lx++) {
          const px = dx === 0 ? lx + 1 : dx === 1 ? CHUNK_X + 1 : 0;
          const pz = dz === 0 ? lz + 1 : dz === 1 ? CHUNK_Z + 1 : 0;
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            const dsti = px + PX * (pz + PZ * y);
            if (n && n.state === ChunkState.Ready) {
              const si = voxelIndex(lx, y, lz);
              pb[dsti] = n.blocks[si];
              pl[dsti] = n.light[si];
            } else {
              // Voisin absent : on suppose de la roche pour éviter un mur de faces.
              pb[dsti] = 1;
              pl[dsti] = 0;
            }
          }
        }
      }
    };

    for (const [dx, dz] of [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ] as const) {
      copyStrip(dx, dz);
    }

    return [pb, pl];
  }

  // --- Débordements de structures ----------------------------------------

  addOverflow(data: Int32Array): void {
    for (let i = 0; i < data.length; i += 4) {
      const x = data[i], y = data[i + 1], z = data[i + 2], id = data[i + 3];
      const k = chunkKey(floorDiv(x, CHUNK_X), floorDiv(z, CHUNK_Z));
      let list = this.overflow.get(k);
      if (!list) { list = []; this.overflow.set(k, list); }
      list.push(x, y, z, id);
      // Application immédiate si le chunk cible est déjà présent.
      const c = this.getChunk(floorDiv(x, CHUNK_X), floorDiv(z, CHUNK_Z));
      if (c && c.state === ChunkState.Ready) {
        this.applyOverflowEntry(c, x, y, z, id);
        this.dirty.add(k);
        c.rev++;
      }
    }
  }

  applyOverflowFor(c: Chunk): void {
    const list = this.overflow.get(chunkKey(c.cx, c.cz));
    if (!list) return;
    for (let i = 0; i < list.length; i += 4) {
      this.applyOverflowEntry(c, list[i], list[i + 1], list[i + 2], list[i + 3]);
    }
  }

  private applyOverflowEntry(c: Chunk, x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const force = (id & 0x100) !== 0;
    const bid = id & 0xff;
    const lx = mod(x, CHUNK_X);
    const lz = mod(z, CHUNK_Z);
    const i = voxelIndex(lx, y, lz);
    if (force || c.blocks[i] === 0) c.blocks[i] = bid;
  }
}
