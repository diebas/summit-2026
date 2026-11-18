// Imita el endpoint RPC de Supabase (/rest/v1/rpc/<función>) sobre un Postgres local,
// para probar el mapa sin tocar el proyecto real.
//   npm run servidor           → http://localhost:8790, clave "anon-key"
// Opcional: simula red mala con FALLA_RESPUESTA=0.3 (30% de las respuestas se "pierden" después de procesar).
import http from 'node:http';
import { startDb, stopDb } from './db.mjs';

export async function startFake({ port = 8790, falla = +process.env.FALLA_RESPUESTA || 0 } = {}) {
  const db = await startDb();
  await db.owner.query("update insc.config set v='2026-12-05' where k='fecha'; update insc.config set v='2026-12-05 12:00:00-03' where k='ahora';");
  const server = http.createServer((req, res) => {
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'content-type': 'application/json' };
    if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', async () => {
      const m = req.url.match(/^\/rest\/v1\/rpc\/(insc_\w+)$/);
      if (!m || req.headers.apikey !== 'anon-key') { res.writeHead(401, h); return res.end('{"message":"no autorizado"}'); }
      const args = JSON.parse(body || '{}'), keys = Object.keys(args).filter((k) => /^p_\w+$/.test(k));
      const sql = `select public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}${k === 'p_args' ? '::jsonb' : ''}`).join(', ')}) r`;
      try {
        const r = await db.anon.query(sql, keys.map((k) => (k === 'p_args' ? JSON.stringify(args[k]) : args[k])));
        if (falla && Math.random() < falla) { req.socket.destroy(); return; }   // se procesó, pero la respuesta "no llega"
        res.writeHead(200, h); res.end(JSON.stringify(r.rows[0].r));
      } catch (e) { res.writeHead(400, h); res.end(JSON.stringify({ message: e.message })); }
    });
  });
  await new Promise((ok) => server.listen(port, ok));
  return { db, server, url: `http://localhost:${port}`, stop: async () => { server.close(); await stopDb(db); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await startFake();
  console.log(`Supabase de prueba en ${f.url} (clave "anon-key", hora simulada 12:00 del 5/12). Ctrl+C para salir.`);
  process.on('SIGINT', async () => { await f.stop(); process.exit(0); });
}
