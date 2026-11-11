/**
 * Serveur de parties multijoueur de VoxelCraft.
 *
 * Une partie = un Durable Object, retrouvé par son code. Il garde :
 * - la graine et le type du monde, choisis par l'hôte à la création ;
 * - toutes les modifications de blocs, dans les trois dimensions ;
 * - le contenu des coffres ;
 * - les créatures et engins (dernier état connu de chacun) ;
 * - quelques drapeaux de partie (dragon vaincu) ;
 * - le mot de passe éventuel, sous forme d'empreinte.
 *
 * Créatures : chacune a un « propriétaire », le joueur dont le navigateur la
 * fait vivre (IA, physique). Il publie son état ; les autres en affichent une
 * copie. Quand il part ou change de dimension, le serveur confie ses
 * créatures à un autre joueur de la même dimension, ou les garde en attente
 * jusqu'au prochain venu.
 *
 * Sécurité, dans l'ordre :
 * 1. le code de partie est long et aléatoire : sans le lien, on n'entre pas ;
 * 2. mot de passe facultatif, vérifié ici et jamais stocké en clair ;
 * 3. seules les pages du jeu (origines autorisées) peuvent se connecter ;
 * 4. contrôles de vraisemblance et limites de débit sur chaque message ;
 * 5. un joueur ne publie l'état que des créatures qui lui sont confiées.
 */

import { DurableObject } from 'cloudflare:workers';

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS: string;
}

const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;
const UID = /^[A-Za-z0-9]{6,16}$/;
const DIMENSIONS = ['overworld', 'nether', 'end'] as const;
type Dim = (typeof DIMENSIONS)[number];
const WORLD_HEIGHT = 128;
const MAX_PLAYERS = 8;
/** Distance maximale entre un joueur et le bloc qu'il modifie. */
const EDIT_RANGE = 14;
/** Débits maximum par seconde et par joueur. */
const MAX_POS_PER_S = 25;
const MAX_EDITS_PER_S = 60;
const MAX_ENT_MSGS_PER_S = 20;
const MAX_EVENTS_PER_S = 40;
/** Créatures publiées par message, et en tout dans une partie. */
const MAX_SNAPS = 150;
const MAX_ENTS = 1500;
/** Taille des lots d'envoi du monde à un nouvel arrivant. */
const EDIT_BATCH = 4000;
const MAX_NAME = 16;
const MAX_ID = 65535;
/** Écriture des créatures en base, au plus toutes les 30 s. */
const PERSIST_EVERY = 30_000;
const PROTOCOL = 2;

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
  d: Dim | null;
  known: boolean;
  window: number;
  pos: number;
  edits: number;
  ents: number;
  events: number;
}

interface Ent {
  d: Dim;
  /** Dernier état publié, tel quel (validé à la réception). */
  s: Record<string, unknown>;
  /** Joueur qui la fait vivre ; 0 = personne pour l'instant. */
  owner: number;
  dirty: boolean;
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
  private ents = new Map<string, Ent>();
  private nextId = 1;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS edits (
          x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, id INTEGER NOT NULL,
          PRIMARY KEY (x, y, z)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS dedits (
          d TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, id INTEGER NOT NULL,
          PRIMARY KEY (d, x, y, z)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS chests (k TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ents (u TEXT PRIMARY KEY, d TEXT NOT NULL, data TEXT NOT NULL);
      `);
      // Les créatures reviennent sans propriétaire : elles seront confiées au
      // premier joueur qui se présentera dans leur dimension.
      for (const r of sql.exec<{ u: string; d: string; data: string }>('SELECT u, d, data FROM ents')) {
        try { this.ents.set(r.u, { d: r.d as Dim, s: JSON.parse(r.data), owner: 0, dirty: false }); } catch { /* ligne abîmée */ }
      }
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
    if (typeof raw !== 'string' || raw.length > 400_000) { this.kick(ws, 'Message invalide.'); return; }
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { this.kick(ws, 'Message illisible.'); return; }
    const a = ws.deserializeAttachment() as Attachment;

    if (msg.t === 'hello') { await this.hello(ws, msg); return; }
    if (!a || a.id === 0) { this.kick(ws, 'Présentation attendue.'); return; }

    const l = this.liveOf(ws);
    const now = Date.now();
    if (now - l.window > 1000) { l.window = now; l.pos = 0; l.edits = 0; l.ents = 0; l.events = 0; }

    switch (msg.t) {
      case 'pos': {
        if (++l.pos > MAX_POS_PER_S) return; // trop bavard : on ignore
        const x = num(msg.x), y = num(msg.y), z = num(msg.z);
        if (x === null || y === null || z === null || Math.abs(x) > 3e7 || Math.abs(z) > 3e7 || y < -64 || y > 512) return;
        const d = dim(msg.d);
        l.x = x; l.y = y; l.z = z; l.known = true;
        if (d !== l.d) this.changeDimension(ws, a, l, d);
        this.broadcast(ws, { t: 'pos', id: a.id, x, y, z, yaw: num(msg.yaw) ?? 0, pitch: num(msg.pitch) ?? 0, d });
        return;
      }
      case 'blocks':
      case 'upload': {
        const list = Array.isArray(msg.e) ? msg.e : [];
        const upload = msg.t === 'upload';
        const d = dim(msg.d);
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
          if (!upload && (l.d !== d || (l.known && Math.hypot(x + 0.5 - l.x, y + 0.5 - l.y, z + 0.5 - l.z) > EDIT_RANGE))) continue;
          ok.push([x, y, z, id]);
        }
        if (ok.length === 0) return;
        const sql = this.ctx.storage.sql;
        for (const [x, y, z, id] of ok) {
          if (d === 'overworld') {
            sql.exec('INSERT INTO edits (x, y, z, id) VALUES (?, ?, ?, ?) ON CONFLICT(x, y, z) DO UPDATE SET id = excluded.id', x, y, z, id);
          } else {
            sql.exec('INSERT INTO dedits (d, x, y, z, id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(d, x, y, z) DO UPDATE SET id = excluded.id', d, x, y, z, id);
          }
        }
        if (!upload) this.broadcast(ws, { t: 'blocks', d, e: ok });
        return;
      }
      case 'ent': {
        if (++l.ents > MAX_ENT_MSGS_PER_S) return;
        const list = Array.isArray(msg.s) ? msg.s : [];
        if (list.length > MAX_SNAPS) { this.kick(ws, 'Trop de créatures d’un coup.'); return; }
        const ok: Record<string, unknown>[] = [];
        for (const raw of list) {
          const s = cleanSnap(raw);
          if (!s) continue;
          const u = s.u as string;
          let e = this.ents.get(u);
          if (!e) {
            // Nouvelle créature : elle appartient à qui la publie.
            if (this.ents.size >= MAX_ENTS) continue;
            e = { d: s.d as Dim, s, owner: a.id, dirty: true };
            this.ents.set(u, e);
          } else if (e.owner !== a.id) {
            continue; // l'état d'une créature confiée à un autre ne se publie pas
          }
          e.s = s;
          e.d = s.d as Dim;
          e.dirty = true;
          ok.push(s);
        }
        if (ok.length) {
          this.broadcast(ws, { t: 'ent', o: a.id, s: ok });
          await this.schedulePersist();
        }
        return;
      }
      case 'gone': {
        const u = typeof msg.u === 'string' ? msg.u : '';
        const e = this.ents.get(u);
        if (!e || (e.owner !== a.id && e.owner !== 0)) return;
        this.ents.delete(u);
        this.ctx.storage.sql.exec('DELETE FROM ents WHERE u = ?', u);
        const drops = Array.isArray(msg.drops) ? msg.drops.slice(0, 16) : [];
        this.broadcast(ws, { t: 'gone', u, killer: num(msg.killer) ?? 0, drops, xp: num(msg.xp) ?? 0 });
        return;
      }
      case 'hit': {
        if (++l.events > MAX_EVENTS_PER_S) return;
        const u = typeof msg.u === 'string' ? msg.u : '';
        const e = this.ents.get(u);
        if (!e || e.owner === 0 || e.owner === a.id) return;
        const dmg = Math.max(0, Math.min(40, num(msg.dmg) ?? 0));
        const kind = msg.kind === 'fold' || msg.kind === 'shear' ? msg.kind : 'hit';
        this.sendTo(e.owner, { t: 'hit', u, by: a.id, dmg, kx: num(msg.kx) ?? 0, kz: num(msg.kz) ?? 0, kind });
        return;
      }
      case 'claim': {
        // Monter un cheval, conduire un véhicule, tenir une bête en laisse :
        // la créature passe à ce joueur, pour qu'elle réponde sans délai.
        if (++l.events > MAX_EVENTS_PER_S) return;
        const u = typeof msg.u === 'string' ? msg.u : '';
        const e = this.ents.get(u);
        if (!e || e.owner === a.id || e.d !== l.d) return;
        if (e.owner !== 0) this.sendTo(e.owner, { t: 'release', u });
        e.owner = a.id;
        this.send(ws, { t: 'own', s: [e.s] });
        return;
      }
      case 'hurt': {
        // Une créature confiée à un joueur blesse un autre joueur.
        if (++l.events > MAX_EVENTS_PER_S) return;
        const to = num(msg.to);
        const dmg = Math.max(0, Math.min(20, num(msg.dmg) ?? 0));
        if (to === null || dmg <= 0) return;
        this.sendTo(to, { t: 'hurt', dmg });
        return;
      }
      case 'chest': {
        if (++l.events > MAX_EVENTS_PER_S) return;
        const d = dim(msg.d);
        const x = int(msg.x), y = int(msg.y), z = int(msg.z);
        if (x === null || y === null || z === null || y < 0 || y >= WORLD_HEIGHT) return;
        const slots = Array.isArray(msg.slots) ? msg.slots.slice(0, 54).map(cleanSlot) : [];
        const k = `${d}:${x},${y},${z}`;
        if (slots.every((s) => s === null)) this.ctx.storage.sql.exec('DELETE FROM chests WHERE k = ?', k);
        else this.ctx.storage.sql.exec('INSERT INTO chests (k, data) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET data = excluded.data', k, JSON.stringify(slots));
        this.broadcast(ws, { t: 'chest', d, x, y, z, slots });
        return;
      }
      case 'flag': {
        if (msg.k !== 'dragonSlain') return;
        this.setMeta('dragonSlain', '1');
        this.broadcast(ws, { t: 'flag', k: 'dragonSlain' });
        return;
      }
      case 'chat': {
        const text = typeof msg.text === 'string' ? msg.text.slice(0, 200).trim() : '';
        if (!text || ++l.events > MAX_EVENTS_PER_S) return;
        this.broadcast(null, { t: 'chat', id: a.id, name: a.name, text });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Un joueur entre dans une dimension (ou y apparaît). Il rend les
   * créatures qu'il faisait vivre ailleurs, reçoit celles qui attendaient
   * quelqu'un ici, et voit toutes celles de sa nouvelle dimension.
   */
  private changeDimension(ws: WebSocket, a: Attachment, l: Live, d: Dim): void {
    l.d = d;
    this.reassignFrom(a.id, (e) => e.d !== d);
    const own: Record<string, unknown>[] = [];
    const seen: Record<string, unknown>[] = [];
    for (const e of this.ents.values()) {
      if (e.d !== d) continue;
      if (e.owner === 0) { e.owner = a.id; own.push(e.s); }
      else if (e.owner !== a.id) seen.push({ ...e.s, o: e.owner });
    }
    for (let i = 0; i < seen.length; i += MAX_SNAPS) this.send(ws, { t: 'ent', s: seen.slice(i, i + MAX_SNAPS) });
    for (let i = 0; i < own.length; i += MAX_SNAPS) this.send(ws, { t: 'own', s: own.slice(i, i + MAX_SNAPS) });
  }

  /** Confie à d'autres les créatures d'un joueur (qui part, ou change de dimension). */
  private reassignFrom(playerId: number, which: (e: Ent) => boolean): void {
    const byDim = new Map<Dim, { ws: WebSocket; id: number } | null>();
    const heir = (d: Dim) => {
      if (byDim.has(d)) return byDim.get(d)!;
      let best: { ws: WebSocket; id: number } | null = null;
      for (const ws of this.ctx.getWebSockets()) {
        const o = ws.deserializeAttachment() as Attachment | null;
        if (!o || o.id === 0 || o.id === playerId) continue;
        if (this.live.get(ws)?.d !== d) continue;
        if (!best || o.id < best.id) best = { ws, id: o.id };
      }
      byDim.set(d, best);
      return best;
    };
    const given = new Map<WebSocket, Record<string, unknown>[]>();
    for (const e of this.ents.values()) {
      if (e.owner !== playerId || !which(e)) continue;
      const h = heir(e.d);
      e.owner = h ? h.id : 0;
      if (h) { if (!given.has(h.ws)) given.set(h.ws, []); given.get(h.ws)!.push(e.s); }
    }
    for (const [ws, list] of given) {
      for (let i = 0; i < list.length; i += MAX_SNAPS) this.send(ws, { t: 'own', s: list.slice(i, i + MAX_SNAPS) });
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
      players.push({ id: o.id, name: o.name, x: lo?.x ?? 0, y: lo?.y ?? 0, z: lo?.z ?? 0, d: lo?.d ?? 'overworld' });
    }
    const sql = this.ctx.storage.sql;
    const count = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM edits').one().n;
    this.send(ws, {
      t: 'welcome', you: a.id, owner, created,
      seed: Number(this.meta('seed')), type: this.meta('type'), mode: Number(this.meta('mode') ?? 0),
      host: this.meta('host'), players, edits: count,
      flags: { dragonSlain: this.meta('dragonSlain') === '1' },
    });

    // Le monde tel qu'il est : toutes les modifications, par lots.
    let batch: Edit[] = [];
    for (const r of sql.exec<{ x: number; y: number; z: number; id: number }>('SELECT x, y, z, id FROM edits')) {
      batch.push([r.x, r.y, r.z, r.id]);
      if (batch.length >= EDIT_BATCH) { this.send(ws, { t: 'blocks', d: 'overworld', e: batch }); batch = []; }
    }
    if (batch.length) this.send(ws, { t: 'blocks', d: 'overworld', e: batch });
    for (const d of ['nether', 'end'] as const) {
      batch = [];
      for (const r of sql.exec<{ x: number; y: number; z: number; id: number }>('SELECT x, y, z, id FROM dedits WHERE d = ?', d)) {
        batch.push([r.x, r.y, r.z, r.id]);
        if (batch.length >= EDIT_BATCH) { this.send(ws, { t: 'blocks', d, e: batch }); batch = []; }
      }
      if (batch.length) this.send(ws, { t: 'blocks', d, e: batch });
    }
    for (const r of sql.exec<{ k: string; data: string }>('SELECT k, data FROM chests')) {
      const m = /^(\w+):(-?\d+),(-?\d+),(-?\d+)$/.exec(r.k);
      if (!m) continue;
      try { this.send(ws, { t: 'chest', d: m[1], x: +m[2], y: +m[3], z: +m[4], slots: JSON.parse(r.data) }); } catch { /* ligne abîmée */ }
    }
    this.send(ws, { t: 'ready' });

    this.broadcast(ws, { t: 'join', id: a.id, name });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  private async leave(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    this.live.delete(ws);
    if (a && a.id !== 0) {
      this.reassignFrom(a.id, () => true);
      this.broadcast(ws, { t: 'leave', id: a.id });
    }
    try { ws.close(1000, 'Au revoir'); } catch { /* déjà fermée */ }
    this.persist();
  }

  // --- Persistance des créatures -----------------------------------------------

  private async schedulePersist(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + PERSIST_EVERY);
  }

  async alarm(): Promise<void> {
    this.persist();
  }

  /** Écrit les créatures modifiées depuis la dernière fois. */
  private persist(): void {
    const sql = this.ctx.storage.sql;
    for (const [u, e] of this.ents) {
      if (!e.dirty) continue;
      e.dirty = false;
      sql.exec('INSERT INTO ents (u, d, data) VALUES (?, ?, ?) ON CONFLICT(u) DO UPDATE SET d = excluded.d, data = excluded.data', u, e.d, JSON.stringify(e.s));
    }
  }

  // --- Outils ------------------------------------------------------------------

  private liveOf(ws: WebSocket): Live {
    let l = this.live.get(ws);
    if (!l) { l = { x: 0, y: 0, z: 0, d: null, known: false, window: 0, pos: 0, edits: 0, ents: 0, events: 0 }; this.live.set(ws, l); }
    return l;
  }

  private send(ws: WebSocket, data: unknown): void {
    try { ws.send(JSON.stringify(data)); } catch { /* connexion perdue */ }
  }

  private sendTo(playerId: number, data: unknown): void {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a && a.id === playerId) { this.send(ws, data); return; }
    }
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

function int(v: unknown): number | null {
  return Number.isInteger(v) && Math.abs(v as number) < 3e7 ? (v as number) : null;
}

function dim(v: unknown): Dim {
  return (DIMENSIONS as readonly string[]).includes(v as string) ? (v as Dim) : 'overworld';
}

/** Ne garde d'un état de créature que des champs connus, de types attendus. */
function cleanSnap(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.u !== 'string' || !UID.test(r.u)) return null;
  if (typeof r.k !== 'string' || !/^[a-z_]{2,24}$/.test(r.k)) return null;
  const x = num(r.x), y = num(r.y), z = num(r.z);
  if (x === null || y === null || z === null || Math.abs(x) > 3e7 || Math.abs(z) > 3e7 || y < -64 || y > 512) return null;
  const s: Record<string, unknown> = { u: r.u, k: r.k, d: dim(r.d), x, y, z };
  for (const f of ['yw', 'h', 'f', 'a', 'ty', 'p', 'r']) {
    const v = num(r[f]);
    if (v !== null) s[f] = v;
  }
  if (Array.isArray(r.lp) && r.lp.length === 3 && r.lp.every((v) => int(v) !== null)) s.lp = r.lp;
  return s;
}

function cleanSlot(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const id = int(v[0]), count = int(v[1]), dmg = int(v[2] ?? 0);
  if (id === null || count === null || dmg === null || id <= 0 || id > MAX_ID || count <= 0 || count > 64) return null;
  return [id, count, dmg];
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
