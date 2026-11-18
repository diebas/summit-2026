// Concurrencia real: muchas conexiones a Postgres a la vez.
// Local: Postgres descartable. Con DATABASE_URL (tu Supabase): crea un taller de prueba "zz-carga",
// lo usa y lo borra al final; no toca los talleres reales ni la hora.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, api, turnoDe, token, REMOTE } from './db.mjs';

const N = +process.env.CARGA_N || 60;
let db, A;
const T = { a: 'zz-carga-a', b: 'zz-carga-b', c: 'zz-carga-c' };

before(async () => {
  db = await startDb(); A = api(db.anon);
  // dos talleres excluyentes entre sí, con turnos sin hora de cierre real (23:58) para que siempre estén abiertos
  await db.owner.query(`
    insert into insc.talleres (id, nombre, tipo, grupo, espera, orden) values
      ('zz-carga', 'Prueba de carga', 'turnos', 'zz-grupo', true, 99), ('zz-carga2', 'Prueba de carga 2', 'turnos', 'zz-grupo', true, 99);
    insert into insc.turnos (id, taller_id, nombre, inicio, fin, cupo, orden) values
      ('${T.a}', 'zz-carga', 'A', '23:58', '23:59', 15, 1), ('${T.c}', 'zz-carga', 'C', '23:00', '23:10', 15, 2),
      ('${T.b}', 'zz-carga2', 'B', '22:00', '22:30', 15, 1);`);
});
after(async () => {
  await db?.owner.query(`delete from insc.inscripciones where taller_id like 'zz-carga%';
    delete from insc.personas where email like 'zz.%@wyeworks.com'; delete from insc.talleres where id like 'zz-carga%';`).catch(() => {});
  await stopDb(db);
});

const vivos = async (turno) => (await db.owner.query(
  `select estado, count(*)::int n from insc.inscripciones where turno_id=$1 and estado<>'baja' group by estado`, [turno])).rows
  .reduce((o, r) => ({ ...o, [r.estado]: r.n }), { confirmado: 0, espera: 0 });

test(`${N} personas a la vez por 15 lugares: exactamente 15 confirmados y el resto en espera`, async () => {
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => A.anotar(`zz.carga${i}@wyeworks.com`, T.a, null, token())));
  const ms = Date.now() - t0;
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs.find((r) => !r.ok)));
  assert.equal(rs.filter((r) => r.estado === 'confirmado').length, 15);
  assert.equal(rs.filter((r) => r.estado === 'espera').length, N - 15);
  assert.deepEqual(rs.filter((r) => r.estado === 'confirmado').map((r) => r.posicion).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.deepEqual(await vivos(T.a), { confirmado: 15, espera: N - 15 });
  console.log(`   ${N} anotaciones simultáneas en ${ms} ms`);
});

test('5 bajas a la vez: suben exactamente 5 de la espera, en orden de llegada', async () => {
  const conf = (await db.owner.query(`select id, token_hash from insc.inscripciones where turno_id=$1 and estado='confirmado' order by creado limit 5`, [T.a])).rows;
  // las bajas las hace la organización (la clave del celular no la tenemos acá)
  const rs = await Promise.all(conf.map((c) => A.admin('baja', { id: c.id }, process.env.INSC_ADMIN_KEY)));
  if (rs.some((r) => r.error === 'no_admin')) return; // en Supabase sin INSC_ADMIN_KEY: se saltea
  assert.ok(rs.every((r) => r.ok));
  assert.deepEqual(await vivos(T.a), { confirmado: 15, espera: N - 20 });
  const subidos = (await db.owner.query(`select email from insc.inscripciones where turno_id=$1 and via='espera' order by confirmado_en`, [T.a])).rows.length;
  assert.equal(subidos, 5);
});

test('la misma persona en dos talleres excluyentes a la vez: queda en uno solo', async () => {
  for (let i = 0; i < 10; i++) {
    const e = `zz.doble${i}@wyeworks.com`;
    const [x, y] = await Promise.all([A.anotar(e, T.b, null, token()), A.anotar(e, T.c, null, token())]);
    const oks = [x, y].filter((r) => r.estado === 'confirmado').length;
    assert.equal(oks, 1, JSON.stringify([x, y]));
    assert.equal([x, y].find((r) => !r.ok).error, 'excluyente');
  }
});

test('doble toque (mismo pedido repetido a la vez): una sola inscripción', async () => {
  const k = token();
  const rs = await Promise.all(Array.from({ length: 5 }, () => A.anotar('zz.toque@wyeworks.com', T.b, null, k)));
  assert.ok(rs.every((r) => r.ok)); assert.equal(new Set(rs.map((r) => r.id)).size, 1);
  const n = (await db.owner.query(`select count(*)::int n from insc.inscripciones where email='zz.toque@wyeworks.com' and estado<>'baja'`)).rows[0].n;
  assert.equal(n, 1);
});
