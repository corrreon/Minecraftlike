/** Pool de workers avec files séparées pour la génération et le maillage. */

import type { MeshResult } from './mesher';
import type { GenKind } from './generator';

interface GenResponse {
  type: 'gen';
  job: number;
  cx: number;
  cz: number;
  blocks: ArrayBuffer;
  biomes: ArrayBuffer;
  heightmap: ArrayBuffer;
  overflow: ArrayBuffer;
}
interface MeshResponse {
  type: 'mesh';
  job: number;
  cx: number;
  cz: number;
  rev: number;
  mesh: MeshResult;
  blocks: ArrayBuffer;
  light: ArrayBuffer;
}
type Response = GenResponse | MeshResponse | { type: 'ready' } | { type: 'error'; job: number; message: string };

interface PendingJob {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
  kind: 'gen' | 'mesh';
}

interface QueuedTask {
  job: number;
  priority: number;
  payload: Record<string, unknown>;
  transfer: Transferable[];
  kind: 'gen' | 'mesh';
}

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: QueuedTask[] = [];
  private pending = new Map<number, PendingJob>();
  private nextJob = 1;
  private busyCount = 0;
  /** Tâche en cours sur chaque worker, pour la rejeter s'il plante. */
  private running = new Map<Worker, number>();
  private readyWorkers = new Set<Worker>();
  /**
   * Appelé si un worker ne peut même pas démarrer — typiquement une page
   * restée ouverte pendant une mise à jour, dont le script n'existe plus sur
   * le serveur. Sans ça, la génération attendrait pour toujours.
   */
  onFatal: ((message: string) => void) | null = null;
  /** Dernière erreur rencontrée dans un worker, pour l'écran de chargement. */
  lastError = '';

  constructor(seed: number, worldType: GenKind = 'normal', size = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('../workers/chunk.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<Response>) => this.onMessage(w, ev.data);
      w.onerror = (ev: ErrorEvent) => {
        ev.preventDefault();
        this.lastError = ev.message || 'script du worker introuvable';
        if (!this.readyWorkers.has(w)) {
          // Le worker n'a jamais démarré : on le retire et ses tâches échouent.
          this.workers = this.workers.filter((x) => x !== w);
          this.idle = this.idle.filter((x) => x !== w);
          this.failRunning(w);
          if (this.workers.length === 0) {
            for (const [job, p] of this.pending) { this.pending.delete(job); p.reject(new Error(this.lastError)); }
            this.queue.length = 0;
            this.onFatal?.(this.lastError);
          }
          return;
        }
        // Erreur en cours de route : la tâche échoue, le worker reprend du service.
        if (this.failRunning(w)) { this.idle.push(w); this.drain(); }
      };
      w.postMessage({ type: 'init', seed, worldType });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get inFlight(): number {
    return this.busyCount;
  }
  get queued(): number {
    return this.queue.length;
  }

  private onMessage(w: Worker, data: Response): void {
    if (data.type === 'ready') { this.readyWorkers.add(w); return; }
    const p = this.pending.get(data.job);
    this.pending.delete(data.job);
    this.running.delete(w);
    this.busyCount--;
    this.idle.push(w);
    if (data.type === 'error') {
      this.lastError = data.message;
      p?.reject(new Error(data.message));
    } else if (p) {
      (p.resolve as (v: Response) => void)(data);
    }
    this.drain();
  }

  /** Fait échouer la tâche en cours d'un worker ; vrai s'il en avait une. */
  private failRunning(w: Worker): boolean {
    const job = this.running.get(w);
    if (job === undefined) return false;
    this.running.delete(w);
    this.busyCount--;
    const p = this.pending.get(job);
    this.pending.delete(job);
    p?.reject(new Error(this.lastError));
    return true;
  }

  private drain(): void {
    while (this.idle.length && this.queue.length) {
      // Priorité croissante = plus urgent.
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[best].priority) best = i;
      const task = this.queue.splice(best, 1)[0];
      const w = this.idle.pop()!;
      this.busyCount++;
      this.running.set(w, task.job);
      w.postMessage(task.payload, task.transfer);
    }
  }

  private submit<T>(kind: 'gen' | 'mesh', payload: Record<string, unknown>, transfer: Transferable[], priority: number): Promise<T> {
    const job = this.nextJob++;
    payload.job = job;
    if (this.workers.length === 0) return Promise.reject(new Error(this.lastError || 'aucun worker'));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(job, { resolve: resolve as (v: never) => void, reject, kind });
      this.queue.push({ job, priority, payload, transfer, kind });
      this.drain();
    });
  }

  generate(cx: number, cz: number, priority: number): Promise<GenResponse> {
    return this.submit<GenResponse>('gen', { type: 'gen', cx, cz }, [], priority);
  }

  mesh(cx: number, cz: number, rev: number, blocks: ArrayBuffer, light: ArrayBuffer, priority: number): Promise<MeshResponse> {
    return this.submit<MeshResponse>('mesh', { type: 'mesh', cx, cz, rev, blocks, light }, [blocks, light], priority);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    this.queue.length = 0;
    this.pending.clear();
  }
}
