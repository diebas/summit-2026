// Base de datos para los tests.
//  - Por defecto levanta un Postgres real y descartable (embedded-postgres) y carga ../supabase.sql.
//  - Con DATABASE_URL usa esa base (por ejemplo tu Supabase) SIN recrear nada: solo lo usan los tests
//    que saben limpiar lo que crean (concurrencia).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(new URL(import.meta.url).pathname);
export const SQL = fs.readFileSync(path.join(here, '..', 'supabase.sql'), 'utf8');
export const ADMIN_KEY = process.env.INSC_ADMIN_KEY || 'clave-de-prueba';
const ADMIN_HASH_TEST = (await import('node:crypto')).createHash('sha256').update(ADMIN_KEY).digest('hex');
export const REMOTE = !!process.env.DATABASE_URL;

let embedded = null;

export async function startDb({ fresh = true } = {}) {
  let connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    // initdb no corre como root: el directorio tiene que ser escribible por el usuario "postgres"
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'insc-pg-'));
    fs.chmodSync(parent, 0o777);
    const port = 54300 + Math.floor(Math.random() * 600);
    embedded = new EmbeddedPostgres({ databaseDir: path.join(parent, 'data'), user: 'postgres', password: 'postgres', port, persistent: false, initdbFlags: ['--locale=C', '--lc-messages=C', '--encoding=UTF8'], onLog: process.env.PG_LOG ? console.log : () => {}, onError: process.env.PG_LOG ? console.error : () => {} });
    // initdb/postgres corren como el usuario "postgres": necesitan un directorio de trabajo que puedan leer
    const cwd = process.cwd(); process.chdir(parent);
    try { await embedded.initialise(); await embedded.start(); } finally { process.chdir(cwd); }
    connectionString = `postgres://postgres:postgres@localhost:${port}/postgres`;
  }
  const owner = new pg.Pool({ connectionString, max: 4, ssl: REMOTE ? { rejectUnauthorized: false } : undefined });
  if (!REMOTE && fresh) {
    await owner.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    end $$; grant usage on schema public to anon, authenticated;`);
    await owner.query(SQL);
    await owner.query(`update insc.config set v=$1 where k='admin_hash'`, [ADMIN_HASH_TEST]);
  }
  // pool "anon": cada conexión entra con el mismo rol sin permisos que usa el mapa
  const anon = new pg.Pool({ connectionString, max: REMOTE ? 30 : 80, ssl: REMOTE ? { rejectUnauthorized: false } : undefined });
  anon.on('connect', (c) => c.query('set role anon'));
  return { owner, anon, connectionString };
}

export async function stopDb(db) {
  await db?.anon?.end().catch(() => {});
  await db?.owner?.end().catch(() => {});
  if (embedded) { await embedded.stop().catch(() => {}); embedded = null; }
}

// API como la ve el mapa (mismas funciones RPC que expone Supabase)
export function api(pool) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0].r;
  return {
    estado: (email) => one('select public.insc_estado($1) r', [email ?? null]),
    anotar: (email, turno, nombre, token) => one('select public.insc_anotarme(p_email => $1, p_turno => $2, p_nombre => $3, p_token => $4) r', [email, turno, nombre ?? null, token ?? null]),
    baja: (id, token) => one('select public.insc_desanotarme($1, $2) r', [id, token]),
    admin: (accion, args, key) => one('select public.insc_admin($1, $2, $3::jsonb) r', [key ?? ADMIN_KEY, accion, JSON.stringify(args ?? {})]),
  };
}

export const turnoDe = (estado, id) => estado.talleres.flatMap((a) => a.turnos).find((t) => t.id === id);
export const token = () => (globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID()).replaceAll('-', '');
