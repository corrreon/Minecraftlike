import { CHUNK_VOLUME, CHUNK_X, CHUNK_Z, LAYER, WORLD_HEIGHT, chunkKey, voxelIndex } from '../core/constants';

export const enum ChunkState {
  Missing = 0,
  Generating = 1,
  Ready = 2,
}

/** Colonne de 16 × 128 × 16 voxels. */
export class Chunk {
  readonly cx: number;
  readonly cz: number;
  readonly key: string;
  /** Bits 1/2/4/8 : bord -X / +X / -Z / +Z modifié depuis le dernier remaillage. */
  borderDirty = 0;
  blocks: Uint8Array;
  /** Nibble haut = lumière du ciel, nibble bas = lumière de bloc. */
  light: Uint8Array;
  biomes: Uint8Array;
  /** Sommet non-air par colonne. */
  height: Uint8Array;
  maxHeight = 0;
  state: ChunkState = ChunkState.Missing;
  /** Incrémenté à chaque modification (blocs ou lumière). */
  rev = 0;
  /** Révision déjà maillée : si < rev, un remaillage est requis. */
  meshedRev = -1;
  /** Un maillage est déjà en vol pour cette révision. */
  meshing = false;
  lit = false;
  /** Modifications du joueur, à persister (index voxel → id de bloc). */
  edits: Map<number, number> | null = null;

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.blocks = new Uint8Array(CHUNK_VOLUME);
    this.light = new Uint8Array(CHUNK_VOLUME);
    this.biomes = new Uint8Array(LAYER);
    this.height = new Uint8Array(LAYER);
  }

  get(x: number, y: number, z: number): number {
    return this.blocks[voxelIndex(x, y, z)];
  }

  set(x: number, y: number, z: number, id: number): void {
    this.blocks[voxelIndex(x, y, z)] = id;
  }

  recomputeColumn(x: number, z: number): void {
    let top = 0;
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (this.blocks[voxelIndex(x, y, z)] !== 0) { top = y; break; }
    }
    this.height[x + z * CHUNK_X] = top;
    if (top > this.maxHeight) this.maxHeight = top;
  }

  recomputeHeights(): void {
    let max = 0;
    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        let top = 0;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          if (this.blocks[voxelIndex(x, y, z)] !== 0) { top = y; break; }
        }
        this.height[x + z * CHUNK_X] = top;
        if (top > max) max = top;
      }
    }
    this.maxHeight = max;
  }

  recordEdit(index: number, id: number): void {
    if (!this.edits) this.edits = new Map();
    this.edits.set(index, id);
  }
}
