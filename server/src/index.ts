/**
 * Serveur de parties multijoueur de VoxelCraft.
 *
 * Une partie = un Durable Object, retrouvé par son code. Il garde :
 * - la graine et le type du monde, choisis par l'hôte à la création ;
 * - toutes les modifications de blocs de l'Overworld (table SQLite) ;
 * - le mot de passe éventuel, sous forme d'empreinte.
 *
 * Les joueurs s'y connectent en WebSocket. Le serveur relaie positions et
 * blocs, et refuse ce qui n'a rien de plausible : bloc posé à l'autre bout du
 * monde, avalanche de messages, coordonnées hors limites.
 *
 * Sécurité, dans l'ordre :
 * 1. le code de partie est long et aléatoire : sans le lien, on n'entre pas ;
 * 2. mot de passe facultatif, vérifié ici et jamais stocké en clair ;
 * 3. seules les pages du jeu (origines autorisées) peuvent se connecter ;
 * 4. contrôles de vraisemblance et limites de débit sur chaque message.
 */

import { DurableObject } from 'cloudflare:workers';

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS: string;
}

const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;
const WORLD_HEIGHT = 128;
const MAX_PLAYERS = 8;
/** Distance maximale entre un joueur et le bloc qu'il modifie. */
const EDIT_RANGE = 14;
/** Débits maximum par seconde et par joueur. */
const MAX_POS_PER_S = 25;
const MAX_EDITS_PER_S = 60;
/** Taille des lots d'envoi du monde à un nouvel arrivant. */
const EDIT_BATCH = 4000;
const MAX_NAME = 16;
const MAX_ID = 65535;
const PROTOCOL = 1;

type Edit = [number, number, number, number];

interface Attachment {
  id: number;
  name: string;
  owner: boolean;
}

interface Live {
  x: number;
  y: number;
  z: number;
  known: boolean;
  window: number;
  pos: number;
  edits: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/sante') {
      return new Response('VoxelCraft : serveur de parties en ligne.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const m = /^\/partie\/([^/]+)$/.exec(url.pathname);
    if (!m) return new Response('Introuvable', { status: 404 });
    const room = m[1];
    if (!ROOM_ID.test(room)) return new Response('Code de partie invalide', { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket attendu', { status: 426 });
    }
    const origin = request.headers.get('Origin') ?? '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    if (!allowed.includes(origin)) return new Response('Origine refusée', { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

export class Room extends DurableObject<Env> {
  private live = new Map<WebSocket, Live>();
  private nextId = 1;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS edits (
          x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, id INTEGER NOT NULL,
          PRIMARY KEY (x, y, z)
        ) WITHOUT ROWID;
      `);
      // Après une mise en veille, les connexions survivent : on repart du
      // plus grand identifiant encore en usage.
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a && a.id >= this.nextId) this.nextId = a.id + 1;
      }
    });
  }

  async fetch(_request: Request): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) {
      return new Response('Partie complète', { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation : la partie ne coûte rien tant que personne n'écrit.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: 0, name: '', owner: false } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Méta ------------------------------------------------------------------

  private meta(k: string): string | null {
    const rows = this.ctx.storage.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray();
    return rows.length ? rows[0].v : null;
  }

  private setMeta(k: string, v: string): void {
    this.ctx.storage.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  // --- Messages ----------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 200_000) { this.kick(ws, 'Message invalide.'); return; }
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { this.kick(ws, 'Message illisible.'); return; }
    const a = ws.deserializeAttachment() as Attachment;

    if (msg.t === 'hello') { await this.hello(ws, msg); return; }
    if (!a || a.id === 0) { this.kick(ws, 'Présentation attendue.'); return; }

    const l = this.liveOf(ws);
    const now = Date.now();
    if (now - l.window > 1000) { l.window = now; l.pos = 0; l.edits = 0; }

    switch (msg.t) {
      case 'pos': {
        if (++l.pos > MAX_POS_PER_S) return; // trop bavard : on ignore
        const x = num(msg.x), y = num(msg.y), z = num(msg.z);
        if (x === null || y === null || z === null || Math.abs(x) > 3e7 || Math.abs(z) > 3e7 || y < -64 || y > 512) return;
        l.x = x; l.y = y; l.z = z; l.known = true;
        this.broadcast(ws, {
          t: 'pos', id: a.id, x, y, z,
          yaw: num(msg.yaw) ?? 0, pitch: num(msg.pitch) ?? 0,
          d: typeof msg.d === 'string' ? msg.d.slice(0, 12) : 'overworld',
        });
        return;
      }
      case 'blocks':
      case 'upload': {
        const list = Array.isArray(msg.e) ? msg.e : [];
        const upload = msg.t === 'upload';
        // Le téléversement du monde de départ est réservé à l'hôte.
        if (upload && !a.owner) { this.kick(ws, 'Seul l’hôte peut envoyer le monde.'); return; }
        if (list.length > (upload ? EDIT_BATCH : 256)) { this.kick(ws, 'Lot trop gros.'); return; }
        if (!upload) {
          l.edits += list.length;
          if (l.edits > MAX_EDITS_PER_S) { this.send(ws, { t: 'error', msg: 'Trop de blocs d’un coup : ralentis.' }); return; }
        }
        const ok: Edit[] = [];
        for (const e of list) {
          if (!Array.isArray(e) || e.length !== 4) continue;
          const [x, y, z, id] = e.map((v) => (Number.isInteger(v) ? (v as number) : NaN));
          if (!Number.isFinite(x + y + z + id)) continue;
          if (y < 0 || y >= WORLD_HEIGHT || id < 0 || id > MAX_ID || Math.abs(x) > 3e7 || Math.abs(z) > 3e7) continue;
          // Un bloc se modifie à portée de main, pas à l'autre bout du monde.
          if (!upload && l.known && Math.hypot(x + 0.5 - l.x, y + 0.5 - l.y, z + 0.5 - l.z) > EDIT_RANGE) continue;
          ok.push([x, y, z, id]);
        }
        if (ok.length === 0) return;
        for (const [x, y, z, id] of ok) {
          this.ctx.storage.sql.exec(
            'INSERT INTO edits (x, y, z, id) VALUES (?, ?, ?, ?) ON CONFLICT(x, y, z) DO UPDATE SET id = excluded.id',
            x, y, z, id,
          );
        }
        if (!upload) this.broadcast(ws, { t: 'blocks', e: ok });
        return;
      }
      case 'chat': {
        const text = typeof msg.text === 'string' ? msg.text.slice(0, 200).trim() : '';
        if (!text || ++l.edits > MAX_EDITS_PER_S) return;
        this.broadcast(null, { t: 'chat', id: a.id, name: a.name, text });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Présentation. L'hôte crée la partie (graine, type, mot de passe) ; les
   * suivants doivent la trouver existante, et donner le bon mot de passe.
   */
  private async hello(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const prev = ws.deserializeAttachment() as Attachment;
    if (prev && prev.id !== 0) return;
    if (msg.v !== PROTOCOL) { this.kick(ws, 'Version du jeu trop ancienne : recharge la page.'); return; }

    const name = cleanName(msg.name);
    const pass = typeof msg.pass === 'string' ? msg.pass.slice(0, 64) : '';
    const ownerToken = typeof msg.owner === 'string' ? msg.owner.slice(0, 64) : '';
    let owner = false;
    let created = false;

    if (this.meta('seed') === null) {
      // Partie inconnue : seul un hôte peut la créer.
      const seed = num(msg.seed);
      const type = msg.type === 'flat' || msg.type === 'oneblock' ? msg.type : 'normal';
      if (!msg.host || seed === null) { this.kick(ws, 'Partie introuvable : vérifie le lien.'); return; }
      const token = randomToken();
      this.setMeta('seed', String(Math.trunc(seed)));
      this.setMeta('type', type);
      this.setMeta('mode', String(num(msg.mode) === 1 ? 1 : 0));
      this.setMeta('host', name);
      this.setMeta('owner', await sha256(token));
      if (pass) this.setMeta('pass', await sha256(`${pass}:${this.ctx.id.toString()}`));
      owner = true;
      created = true;
      this.send(ws, { t: 'owner', token });
    } else {
      const stored = this.meta('pass');
      if (stored && stored !== (await sha256(`${pass}:${this.ctx.id.toString()}`))) {
        this.kick(ws, 'Mot de passe incorrect.');
        return;
      }
      owner = ownerToken !== '' && this.meta('owner') === (await sha256(ownerToken));
    }

    const a: Attachment = { id: this.nextId++, name, owner };
    ws.serializeAttachment(a);

    const players = [];
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const o = other.deserializeAttachment() as Attachment | null;
      if (!o || o.id === 0) continue;
      const lo = this.live.get(other);
      players.push({ id: o.id, name: o.name, x: lo?.x ?? 0, y: lo?.y ?? 0, z: lo?.z ?? 0 });
    }
    const count = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM edits').one().n;
    this.send(ws, {
      t: 'welcome', you: a.id, owner, created,
      seed: Number(this.meta('seed')), type: this.meta('type'), mode: Number(this.meta('mode') ?? 0),
      host: this.meta('host'), players, edits: count,
    });

    // Le monde tel qu'il est : toutes les modifications, par lots.
    let batch: Edit[] = [];
    for (const r of this.ctx.storage.sql.exec<{ x: number; y: number; z: number; id: number }>('SELECT x, y, z, id FROM edits')) {
      batch.push([r.x, r.y, r.z, r.id]);
      if (batch.length >= EDIT_BATCH) { this.send(ws, { t: 'blocks', e: batch }); batch = []; }
    }
    if (batch.length) this.send(ws, { t: 'blocks', e: batch });
    this.send(ws, { t: 'ready' });

    this.broadcast(ws, { t: 'join', id: a.id, name });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  private leave(ws: WebSocket): void {
    const a = ws.deserializeAttachment() as Attachment | null;
    this.live.delete(ws);
    if (a && a.id !== 0) this.broadcast(ws, { t: 'leave', id: a.id });
    try { ws.close(1000, 'Au revoir'); } catch { /* déjà fermée */ }
  }

  // --- Outils ------------------------------------------------------------------

  private liveOf(ws: WebSocket): Live {
    let l = this.live.get(ws);
    if (!l) { l = { x: 0, y: 0, z: 0, known: false, window: 0, pos: 0, edits: 0 }; this.live.set(ws, l); }
    return l;
  }

  private send(ws: WebSocket, data: unknown): void {
    try { ws.send(JSON.stringify(data)); } catch { /* connexion perdue */ }
  }

  private broadcast(except: WebSocket | null, data: unknown): void {
    const text = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a || a.id === 0) continue;
      try { ws.send(text); } catch { /* connexion perdue */ }
    }
  }

  private kick(ws: WebSocket, reason: string): void {
    this.send(ws, { t: 'error', msg: reason, fatal: true });
    this.live.delete(ws);
    try { ws.close(4000, reason.slice(0, 100)); } catch { /* déjà fermée */ }
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  // Lettres, chiffres, espaces et quelques signes : pas de balises, pas de contrôle.
  const clean = s.replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, MAX_NAME);
  return clean || 'Joueur';
}

function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
