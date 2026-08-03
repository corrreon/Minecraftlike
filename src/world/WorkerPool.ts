/** Pool de workers avec files séparées pour la génération et le maillage. */

import type { MeshResult } from './mesher';

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
type Response = GenResponse | MeshResponse | { type: 'ready' };

interface PendingJob {
  resolve: (v: never) => void;
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

  constructor(seed: number, flat = false, size = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('../workers/chunk.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<Response>) => this.onMessage(w, ev.data);
      w.postMessage({ type: 'init', seed, flat });
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
    if (data.type === 'ready') return;
    const p = this.pending.get(data.job);
    this.pending.delete(data.job);
    this.busyCount--;
    this.idle.push(w);
    if (p) (p.resolve as (v: Response) => void)(data);
    this.drain();
  }

  private drain(): void {
    while (this.idle.length && this.queue.length) {
      // Priorité croissante = plus urgent.
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[best].priority) best = i;
      const task = this.queue.splice(best, 1)[0];
      const w = this.idle.pop()!;
      this.busyCount++;
      w.postMessage(task.payload, task.transfer);
    }
  }

  private submit<T>(kind: 'gen' | 'mesh', payload: Record<string, unknown>, transfer: Transferable[], priority: number): Promise<T> {
    const job = this.nextJob++;
    payload.job = job;
    return new Promise<T>((resolve) => {
      this.pending.set(job, { resolve: resolve as (v: never) => void, kind });
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
