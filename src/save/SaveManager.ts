/**
 * Persistance locale via IndexedDB.
 *
 * Seuls les deltas sont stockés : le terrain est reproductible à partir de la
 * graine, on ne conserve donc que les blocs modifiés par le joueur, son état
 * et son inventaire. Un monde de plusieurs heures tient dans quelques centaines
 * de kilo-octets.
 */

import { chunkKey } from '../core/constants';
import type { Dimension } from '../world/generator';

const DB_NAME = 'voxelcraft';
const DB_VERSION = 1;
const STORE_WORLDS = 'worlds';
const STORE_CHUNKS = 'chunks';
const STORE_PLAYER = 'players';

export interface WorldMeta {
  id: string;
  name: string;
  seed: number;
  mode: number;
  created: number;
  lastPlayed: number;
  /** Temps de jeu cumulé en secondes. */
  playtime: number;
  dayTime: number;
  /** Monde superplat, choisi à la création (ancien format, encore lu). */
  flat?: boolean;
  /** Type de monde : `normal`, `flat` ou `oneblock`. */
  type?: 'normal' | 'flat' | 'oneblock';
  /** Mode « oneblock » : nombre de blocs cassés depuis le début. */
  oneblock?: number;
  /** Dimension où le joueur s'est déconnecté. */
  dimension?: Dimension;
  /** Position de retour dans l'Overworld, mémorisée en entrant dans un portail. */
  returnPos?: [number, number, number];
}

export interface PlayerSave {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  food: number;
  saturation: number;
  xp: number;
  level: number;
  mode: number;
  selected: number;
  main: (null | [number, number, number])[];
  armor: (null | [number, number, number])[];
  spawn: [number, number, number] | null;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((resolve) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE_WORLDS)) db.createObjectStore(STORE_WORLDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) db.createObjectStore(STORE_CHUNKS);
      if (!db.objectStoreNames.contains(STORE_PLAYER)) db.createObjectStore(STORE_PLAYER);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => resolve(null);
  });
}

export async function listWorlds(db: IDBDatabase | null): Promise<WorldMeta[]> {
  if (!db) return [];
  const tx = db.transaction(STORE_WORLDS, 'readonly');
  const all = await req(tx.objectStore(STORE_WORLDS).getAll() as IDBRequest<WorldMeta[]>);
  return all.sort((a, b) => b.lastPlayed - a.lastPlayed);
}

export async function deleteWorld(db: IDBDatabase | null, id: string): Promise<void> {
  if (!db) return;
  const tx = db.transaction([STORE_WORLDS, STORE_CHUNKS, STORE_PLAYER], 'readwrite');
  tx.objectStore(STORE_WORLDS).delete(id);
  tx.objectStore(STORE_PLAYER).delete(id);
  // Les clés de chunk sont préfixées par l'identifiant du monde.
  const store = tx.objectStore(STORE_CHUNKS);
  const range = IDBKeyRange.bound(`${id}:`, `${id}:￿`);
  const cursorReq = store.openKeyCursor(range);
  await new Promise<void>((resolve) => {
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (!c) { resolve(); return; }
      store.delete(c.key);
      c.continue();
    };
    cursorReq.onerror = () => resolve();
  });
}

/**
 * Gère les modifications d'un monde en mémoire et les écrit par lots.
 */
export class SaveManager {
  private edits = new Map<string, Map<number, number>>();
  private dirtyKeys = new Set<string>();
  private flushTimer: number | null = null;
  /**
   * Dimension courante. Les modifications de blocs sont rangées sous une clé
   * préfixée, sauf dans l'Overworld qui garde la clé nue — c'est ce qui permet
   * de relire les mondes créés avant l'arrivée du Nether.
   */
  dimension: Dimension = 'overworld';

  private dimKey(cx: number, cz: number): string {
    const k = chunkKey(cx, cz);
    return this.dimension === 'overworld' ? k : `${this.dimension}/${k}`;
  }

  constructor(
    private db: IDBDatabase | null,
    readonly meta: WorldMeta,
  ) {}

  static async load(db: IDBDatabase | null, meta: WorldMeta): Promise<SaveManager> {
    const m = new SaveManager(db, meta);
    if (db) await m.loadAllEdits();
    return m;
  }

  private async loadAllEdits(): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(STORE_CHUNKS, 'readonly');
    const store = tx.objectStore(STORE_CHUNKS);
    const range = IDBKeyRange.bound(`${this.meta.id}:`, `${this.meta.id}:￿`);
    const cursor = store.openCursor(range);
    await new Promise<void>((resolve) => {
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) { resolve(); return; }
        const key = String(c.key).slice(this.meta.id.length + 1);
        const value = c.value as { i: Int32Array; b: Uint8Array };
        const map = new Map<number, number>();
        const idx = value.i;
        const blk = value.b;
        for (let k = 0; k < idx.length; k++) map.set(idx[k], blk[k]);
        this.edits.set(key, map);
        c.continue();
      };
      cursor.onerror = () => resolve();
    });
  }

  getEdits(cx: number, cz: number): Map<number, number> | undefined {
    return this.edits.get(this.dimKey(cx, cz));
  }

  /** Enregistre une modification unitaire (appelé à chaque bloc posé/cassé). */
  recordEdit(cx: number, cz: number, index: number, block: number): void {
    const key = this.dimKey(cx, cz);
    let m = this.edits.get(key);
    if (!m) { m = new Map(); this.edits.set(key, m); }
    m.set(index, block);
    this.dirtyKeys.add(key);
    this.scheduleFlush();
  }

  storeEdits(cx: number, cz: number, map: Map<number, number>): void {
    const key = this.dimKey(cx, cz);
    this.edits.set(key, new Map(map));
    this.dirtyKeys.add(key);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 2500);
  }

  async flush(): Promise<void> {
    if (!this.db || this.dirtyKeys.size === 0) return;
    const keys = Array.from(this.dirtyKeys);
    this.dirtyKeys.clear();
    const tx = this.db.transaction(STORE_CHUNKS, 'readwrite');
    const store = tx.objectStore(STORE_CHUNKS);
    for (const key of keys) {
      const map = this.edits.get(key);
      if (!map || map.size === 0) {
        store.delete(`${this.meta.id}:${key}`);
        continue;
      }
      const i = new Int32Array(map.size);
      const b = new Uint8Array(map.size);
      let k = 0;
      for (const [idx, blk] of map) { i[k] = idx; b[k] = blk; k++; }
      store.put({ i, b }, `${this.meta.id}:${key}`);
    }
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  }

  async savePlayer(state: PlayerSave): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction([STORE_PLAYER, STORE_WORLDS], 'readwrite');
    tx.objectStore(STORE_PLAYER).put(state, this.meta.id);
    tx.objectStore(STORE_WORLDS).put(this.meta);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async loadPlayer(): Promise<PlayerSave | null> {
    if (!this.db) return null;
    const tx = this.db.transaction(STORE_PLAYER, 'readonly');
    const v = await req(tx.objectStore(STORE_PLAYER).get(this.meta.id) as IDBRequest<PlayerSave | undefined>);
    return v ?? null;
  }

  async createOrUpdateMeta(): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(STORE_WORLDS, 'readwrite');
    tx.objectStore(STORE_WORLDS).put(this.meta);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  get editCount(): number {
    let n = 0;
    for (const m of this.edits.values()) n += m.size;
    return n;
  }
}
