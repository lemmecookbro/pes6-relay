// pes6relay: relevo WebSocket para PES6 (imita LocalRelay.java / sv.optijuegos.net).
// wss://<worker>/pes6?room=<sala> -> responde {"type":"joined","room":"<sala>"}, ignora textos,
// reenvia cada trama binaria a los DEMAS de la sala (sin eco). Una sala = un Durable Object.
import { DurableObject } from "cloudflare:workers";

const MAX_PAYLOAD = 1 << 20; // 1 MiB, igual que LocalRelay
const MAX_PER_ROOM = 16;

// HEALTH3861V: registro central (un solo Durable Object "r"): cada Sala le avisa cuantos hay al entrar/salir.
// /health lo lee y arma el JSON que espera la app (ONL184): {"clients":N,"lobby_states":{sala:{menu,searching,playing}}}.
export class Registro extends DurableObject {
  async set(room, n) {
    if (n > 0) await this.ctx.storage.put("s:" + room, n);
    else await this.ctx.storage.delete("s:" + room);
  }
  async snapshot() {
    const all = await this.ctx.storage.list({ prefix: "s:" });
    let clients = 0;
    const lobby = {};
    for (const [k, n] of all) {
      clients += n;
      lobby[k.slice(2)] = { menu: n, searching: 0, playing: 0 }; // no se distingue el estado: todo en "menu"
    }
    return { clients: clients, lobby_states: lobby };
  }
}

export class Sala extends DurableObject {
  avisar(room, n) {
    try {
      this.ctx.waitUntil(this.env.REG.get(this.env.REG.idFromName("r")).set(room, n).catch(() => { }));
    } catch (e) { }
  }

  async fetch(req) {
    const room = new URL(req.url).searchParams.get("room") || "";
    if (this.ctx.getWebSockets().length >= MAX_PER_ROOM) {
      return new Response("sala llena", { status: 503 });
    }
    const pair = new WebSocketPair();
    const cli = pair[0];
    const srv = pair[1];
    this.ctx.acceptWebSocket(srv);
    try { srv.serializeAttachment({ room: room }); } catch (e) { }
    srv.send(JSON.stringify({ type: "joined", room: room }));
    this.avisar(room, this.ctx.getWebSockets().length);
    return new Response(null, { status: 101, webSocket: cli });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg === "string") return; // hello/status: se ignoran
    if (msg.byteLength > MAX_PAYLOAD) return;
    for (const o of this.ctx.getWebSockets()) {
      if (o === ws) continue;
      try { o.send(msg); } catch (e) { }
    }
  }

  salio(ws) {
    try {
      const a = ws.deserializeAttachment();
      if (a && a.room) this.avisar(a.room, this.ctx.getWebSockets().filter((o) => o !== ws).length);
    } catch (e) { }
  }

  webSocketClose(ws, code) {
    this.salio(ws);
    try { ws.close(code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1000, "bye"); } catch (e) { }
  }

  webSocketError(ws) {
    this.salio(ws);
    try { ws.close(1011, "error"); } catch (e) { }
  }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/pes6") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("se espera websocket", { status: 426 });
      const room = u.searchParams.get("room") || "";
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(room)) return new Response("sala invalida", { status: 400 });
      return env.SALA.get(env.SALA.idFromName(room)).fetch(req);
    }
    if (u.pathname === "/health") {
      let h = { clients: 0, lobby_states: {} };
      try { h = await env.REG.get(env.REG.idFromName("r")).snapshot(); } catch (e) { }
      return new Response(JSON.stringify(h), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (u.pathname === "/info") return new Response("{}", { headers: { "content-type": "application/json" } });
    return new Response("pes6relay ok");
  },
};
