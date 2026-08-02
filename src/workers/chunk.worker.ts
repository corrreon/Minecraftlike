/// <reference lib="webworker" />
/**
 * Worker polyvalent : génération de terrain et maillage.
 * Un pool de ces workers est piloté par `WorkerPool` sur le thread principal.
 */

import { TerrainGenerator } from '../world/generator';
import { meshChunk } from '../world/mesher';

export interface InitMsg { type: 'init'; seed: number }
export interface GenMsg { type: 'gen'; job: number; cx: number; cz: number }
export interface MeshMsg { type: 'mesh'; job: number; cx: number; cz: number; rev: number; blocks: ArrayBuffer; light: ArrayBuffer }
export type WorkerRequest = InitMsg | GenMsg | MeshMsg;

let gen: TerrainGenerator | null = null;

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      gen = new TerrainGenerator(msg.seed);
      (self as DedicatedWorkerGlobalScope).postMessage({ type: 'ready' });
      break;

    case 'gen': {
      if (!gen) throw new Error('Worker non initialisé');
      const r = gen.generate(msg.cx, msg.cz);
      (self as DedicatedWorkerGlobalScope).postMessage(
        {
          type: 'gen',
          job: msg.job,
          cx: msg.cx,
          cz: msg.cz,
          blocks: r.blocks.buffer,
          biomes: r.biomes.buffer,
          heightmap: r.heightmap.buffer,
          overflow: r.overflow.buffer,
        },
        [r.blocks.buffer, r.biomes.buffer, r.heightmap.buffer, r.overflow.buffer],
      );
      break;
    }

    case 'mesh': {
      const blocks = new Uint8Array(msg.blocks);
      const light = new Uint8Array(msg.light);
      const m = meshChunk(blocks, light);
      const transfer: ArrayBuffer[] = [msg.blocks, msg.light];
      for (const layer of [m.opaque, m.cutout, m.translucent]) {
        if (!layer) continue;
        transfer.push(
          layer.position.buffer as ArrayBuffer,
          layer.normal.buffer as ArrayBuffer,
          layer.uv.buffer as ArrayBuffer,
          layer.color.buffer as ArrayBuffer,
          layer.data.buffer as ArrayBuffer,
          layer.index.buffer as ArrayBuffer,
        );
      }
      (self as DedicatedWorkerGlobalScope).postMessage(
        { type: 'mesh', job: msg.job, cx: msg.cx, cz: msg.cz, rev: msg.rev, mesh: m, blocks: msg.blocks, light: msg.light },
        transfer,
      );
      break;
    }
  }
};
