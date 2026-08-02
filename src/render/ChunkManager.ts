/**
 * Streaming des chunks : demande de génération, maillage asynchrone, upload GPU
 * étalé dans le temps et déchargement des zones éloignées.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  Sphere,
  Vector3,
  type Material,
} from 'three';
import { CHUNK_X, CHUNK_Z, WORLD_HEIGHT, chunkKey, floorDiv, parseChunkKey } from '../core/constants';
import { ChunkState } from '../world/Chunk';
import type { LayerBuffers } from '../world/mesher';
import type { World } from '../world/World';
import type { WorkerPool } from '../world/WorkerPool';
import type { SaveManager } from '../save/SaveManager';

interface ChunkMeshes {
  opaque: Mesh | null;
  cutout: Mesh | null;
  water: Mesh | null;
}

const BOUND = new Sphere(new Vector3(CHUNK_X / 2, WORLD_HEIGHT / 2, CHUNK_Z / 2), 66);

function buildGeometry(l: LayerBuffers): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(l.position, 3));
  g.setAttribute('normal', new BufferAttribute(l.normal, 3, true));
  g.setAttribute('uv', new BufferAttribute(l.uv, 2));
  g.setAttribute('tint', new BufferAttribute(l.color, 3, true));
  g.setAttribute('vdata', new BufferAttribute(l.data, 1));
  g.setIndex(new BufferAttribute(l.index, 1));
  g.boundingSphere = BOUND.clone();
  return g;
}

export interface ChunkManagerStats {
  loaded: number;
  meshed: number;
  pendingGen: number;
  pendingMesh: number;
  uploadQueue: number;
  triangles: number;
}

export class ChunkManager {
  readonly group = new Group();
  private meshes = new Map<string, ChunkMeshes>();
  private pendingGen = new Set<string>();
  private pendingMesh = new Set<string>();
  private uploadQueue: { key: string; cx: number; cz: number; rev: number; layers: [LayerBuffers | null, LayerBuffers | null, LayerBuffers | null] }[] = [];
  private centerX = 0;
  private centerZ = 0;

  renderDistance = 8;
  /** Nombre maximal de générations simultanées. */
  maxConcurrentGen = 12;
  maxConcurrentMesh = 8;
  /** Uploads GPU par image. */
  maxUploadsPerFrame = 3;
  triangles = 0;

  constructor(
    private world: World,
    private pool: WorkerPool,
    private materials: { opaque: Material; cutout: Material; water: Material },
    private save: SaveManager | null,
  ) {
    this.group.name = 'chunks';
    this.group.matrixAutoUpdate = false;
  }

  setCenter(x: number, z: number): void {
    this.centerX = floorDiv(Math.floor(x), CHUNK_X);
    this.centerZ = floorDiv(Math.floor(z), CHUNK_Z);
  }

  get center(): [number, number] {
    return [this.centerX, this.centerZ];
  }

  /** Vrai lorsque le chunk contenant la position est prêt à être foulé. */
  isReadyAt(x: number, z: number): boolean {
    return this.world.isLoaded(floorDiv(Math.floor(x), CHUNK_X), floorDiv(Math.floor(z), CHUNK_Z));
  }

  update(): void {
    this.requestGeneration();
    this.requestMeshes();
    this.flushUploads();
    this.unloadFar();
  }

  // --- Génération ---------------------------------------------------------

  private requestGeneration(): void {
    if (this.pendingGen.size >= this.maxConcurrentGen) return;
    const r = this.renderDistance;
    const candidates: { cx: number; cz: number; d: number }[] = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = dx * dx + dz * dz;
        if (d > r * r + r) continue;
        const cx = this.centerX + dx;
        const cz = this.centerZ + dz;
        const key = chunkKey(cx, cz);
        if (this.pendingGen.has(key)) continue;
        const c = this.world.chunks.get(key);
        if (c && c.state !== ChunkState.Missing) continue;
        candidates.push({ cx, cz, d });
      }
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => a.d - b.d);

    const room = this.maxConcurrentGen - this.pendingGen.size;
    for (let i = 0; i < Math.min(room, candidates.length); i++) {
      const { cx, cz, d } = candidates[i];
      const key = chunkKey(cx, cz);
      this.pendingGen.add(key);
      const chunk = this.world.getOrCreateChunk(cx, cz);
      chunk.state = ChunkState.Generating;
      this.pool
        .generate(cx, cz, d)
        .then((res) => this.onGenerated(res))
        .catch(() => {
          this.pendingGen.delete(key);
          chunk.state = ChunkState.Missing;
        });
    }
  }

  private onGenerated(res: { cx: number; cz: number; blocks: ArrayBuffer; biomes: ArrayBuffer; heightmap: ArrayBuffer; overflow: ArrayBuffer }): void {
    const key = chunkKey(res.cx, res.cz);
    this.pendingGen.delete(key);
    const c = this.world.chunks.get(key);
    if (!c) return; // déchargé entre-temps

    c.blocks.set(new Uint8Array(res.blocks));
    c.biomes.set(new Uint8Array(res.biomes));
    c.height.set(new Uint8Array(res.heightmap));
    c.maxHeight = 0;
    for (let i = 0; i < c.height.length; i++) if (c.height[i] > c.maxHeight) c.maxHeight = c.height[i];
    c.state = ChunkState.Ready;

    // Débordements de structures venus des chunks voisins, puis modifications
    // du joueur restaurées depuis la sauvegarde.
    this.world.applyOverflowFor(c);
    this.world.addOverflow(new Int32Array(res.overflow));
    const edits = this.save?.getEdits(res.cx, res.cz);
    if (edits) {
      for (const [idx, id] of edits) c.blocks[idx] = id;
      c.edits = new Map(edits);
    }
    c.recomputeHeights();

    this.world.initChunkLight(c);
    this.world.dirty.add(key);
    // Les voisins doivent être remaillés : leurs faces de bord changent.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      this.world.markDirty(res.cx + dx, res.cz + dz);
    }
  }

  // --- Maillage -----------------------------------------------------------

  private requestMeshes(): void {
    if (this.world.dirty.size === 0) return;
    if (this.pendingMesh.size >= this.maxConcurrentMesh) return;

    // Priorité : les chunks les plus proches du joueur d'abord.
    const list: { key: string; d: number }[] = [];
    for (const key of this.world.dirty) {
      const [cx, cz] = parseChunkKey(key);
      const dx = cx - this.centerX;
      const dz = cz - this.centerZ;
      list.push({ key, d: dx * dx + dz * dz });
    }
    list.sort((a, b) => a.d - b.d);

    let room = this.maxConcurrentMesh - this.pendingMesh.size;
    for (const { key, d } of list) {
      if (room <= 0) break;
      if (this.pendingMesh.has(key)) continue;
      const c = this.world.chunks.get(key);
      if (!c || c.state !== ChunkState.Ready) {
        this.world.dirty.delete(key);
        continue;
      }
      // Un chunk n'est maillé que si ses quatre voisins directs existent :
      // sinon on afficherait un mur de faces artificielles.
      if (!this.neighborsReady(c.cx, c.cz)) continue;

      this.world.dirty.delete(key);
      this.pendingMesh.add(key);
      const rev = c.rev;
      const [pb, pl] = this.world.buildPadded(c);
      room--;
      this.pool
        .mesh(c.cx, c.cz, rev, pb.buffer as ArrayBuffer, pl.buffer as ArrayBuffer, d)
        .then((res) => {
          this.pendingMesh.delete(key);
          this.world.recyclePad(res.blocks, res.light);
          const cur = this.world.chunks.get(key);
          if (!cur || cur.state !== ChunkState.Ready) return;
          this.uploadQueue.push({
            key,
            cx: res.cx,
            cz: res.cz,
            rev: res.rev,
            layers: [res.mesh.opaque, res.mesh.cutout, res.mesh.translucent],
          });
        })
        .catch(() => {
          this.pendingMesh.delete(key);
          this.world.dirty.add(key);
        });
    }
  }

  private neighborsReady(cx: number, cz: number): boolean {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = this.world.chunks.get(chunkKey(cx + dx, cz + dz));
      if (!n || n.state !== ChunkState.Ready) return false;
    }
    return true;
  }

  // --- Upload GPU ---------------------------------------------------------

  private flushUploads(): void {
    if (this.uploadQueue.length === 0) return;
    // Rattrapage : plus la file est longue, plus on téléverse par image.
    let budget = Math.min(14, this.maxUploadsPerFrame + (this.uploadQueue.length >> 4));
    while (budget-- > 0 && this.uploadQueue.length) {
      const task = this.uploadQueue.shift()!;
      const c = this.world.chunks.get(task.key);
      if (!c) continue;
      const entry = this.getOrCreateEntry(task.key);
      const mats = [this.materials.opaque, this.materials.cutout, this.materials.water];
      const slots: (keyof ChunkMeshes)[] = ['opaque', 'cutout', 'water'];
      for (let i = 0; i < 3; i++) {
        const slot = slots[i];
        const layer = task.layers[i];
        const old = entry[slot];
        if (old) {
          old.geometry.dispose();
          this.group.remove(old);
          entry[slot] = null;
        }
        if (!layer) continue;
        const mesh = new Mesh(buildGeometry(layer), mats[i]);
        mesh.position.set(task.cx * CHUNK_X, 0, task.cz * CHUNK_Z);
        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = i === 2 ? 10 : 0;
        mesh.name = `${task.key}:${slot}`;
        entry[slot] = mesh;
        this.group.add(mesh);
      }
      c.meshedRev = task.rev;
      // Une modification est survenue pendant le maillage : on recommence.
      if (c.rev !== task.rev) this.world.dirty.add(task.key);
      this.meshesChanged = true;
    }
  }

  private meshesChanged = false;

  private getOrCreateEntry(key: string): ChunkMeshes {
    let e = this.meshes.get(key);
    if (!e) {
      e = { opaque: null, cutout: null, water: null };
      this.meshes.set(key, e);
    }
    return e;
  }

  private recountTriangles(): void {
    if (!this.meshesChanged) return;
    this.meshesChanged = false;
    let tris = 0;
    for (const e of this.meshes.values()) {
      for (const m of [e.opaque, e.cutout, e.water]) {
        if (m && m.visible) tris += (m.geometry.index?.count ?? 0) / 3;
      }
    }
    this.triangles = tris;
  }

  // --- Déchargement -------------------------------------------------------

  private unloadFar(): void {
    const limit = this.renderDistance + 2;
    for (const key of Array.from(this.world.chunks.keys())) {
      const [cx, cz] = parseChunkKey(key);
      const dx = cx - this.centerX;
      const dz = cz - this.centerZ;
      if (Math.abs(dx) <= limit && Math.abs(dz) <= limit) continue;
      if (this.pendingGen.has(key) || this.pendingMesh.has(key)) continue;
      const c = this.world.chunks.get(key);
      if (c?.edits && c.edits.size) this.save?.storeEdits(cx, cz, c.edits);
      this.disposeMeshes(key);
      this.world.removeChunk(cx, cz);
    }
  }

  private disposeMeshes(key: string): void {
    const e = this.meshes.get(key);
    if (!e) return;
    for (const m of [e.opaque, e.cutout, e.water]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.meshes.delete(key);
    this.meshesChanged = true;
  }

  /** Force le remaillage de tout ce qui est chargé (changement de qualité). */
  remeshAll(): void {
    for (const c of this.world.chunks.values()) {
      if (c.state === ChunkState.Ready) this.world.dirty.add(c.key);
    }
  }

  stats(): ChunkManagerStats {
    this.recountTriangles();
    let meshed = 0;
    for (const e of this.meshes.values()) if (e.opaque || e.cutout || e.water) meshed++;
    return {
      loaded: this.world.chunks.size,
      meshed,
      pendingGen: this.pendingGen.size,
      pendingMesh: this.pendingMesh.size,
      uploadQueue: this.uploadQueue.length,
      triangles: this.triangles,
    };
  }

  dispose(): void {
    for (const key of Array.from(this.meshes.keys())) this.disposeMeshes(key);
    this.uploadQueue.length = 0;
  }
}
