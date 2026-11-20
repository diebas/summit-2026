// Reglas de inscripción sobre un Postgres real y descartable (no toca Supabase).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, api, turnoDe, token, REMOTE } from './db.mjs';

let db, A;
const at = (hhmm) => A.admin('config', { ahora: `2026-12-05 ${hhmm}:00-03` });

before(async () => {
  if (REMOTE) return;
  db = await startDb(); A = api(db.anon);
  await A.admin('config', { fecha: '2026-12-05' }); await at('12:00');
});
after(() => stopDb(db));
const skip = REMOTE ? 'solo con la base local (cambia la hora y reinicia datos)' : false;

test('seguridad: el rol público no lee tablas ni funciones internas', { skip }, async () => {
  for (const q of ['select * from insc.inscripciones', 'select * from insc.config', "select insc.promover('sushi-a')"]) {
    await assert.rejects(db.anon.query(q), /permission denied/, q);
  }
  assert.equal((await A.admin('lista', {}, 'mala')).error, 'no_admin');
});

test('solo mails @wyeworks.com; mail normalizado y nombre derivado', { skip }, async () => {
  assert.equal((await A.anotar('juan@gmail.com', 'sushi-a')).error, 'dominio');
  assert.equal((await A.anotar('juan@wyeworks.com.ar', 'sushi-a')).error, 'dominio');
  const r = await A.anotar('  Ana.Perez@WyeWorks.com ', 'sushi-a');
  assert.equal(r.estado, 'confirmado'); assert.equal(r.nombre, 'Ana Perez');
  assert.equal((await A.anotar('dbaste@wyeworks.com', 'sushi-b', 'Diego Baste')).nombre, 'Diego Baste');
});

test('un solo turno por taller', { skip }, async () => {
  assert.equal((await A.anotar('ana.perez@wyeworks.com', 'sushi-b')).error, 'ya_anotado');
});

test('cupo, orden de llegada, espera y promoción al bajarse', { skip }, async () => {
  const r = {};
  for (let i = 2; i <= 15; i++) r[i] = await A.anotar(`p${i}@wyeworks.com`, 'sushi-a');
  assert.equal(r[15].estado, 'confirmado'); assert.equal(r[15].posicion, 15);
  const w1 = await A.anotar('w1@wyeworks.com', 'sushi-a'), w2 = await A.anotar('w2@wyeworks.com', 'sushi-a');
  assert.deepEqual([w1.estado, w1.posicion, w2.posicion], ['espera', 1, 2]);
  let t = turnoDe(await A.estado(), 'sushi-a');
  assert.equal(t.confirmados.length, 15); assert.equal(t.espera.length, 2); assert.equal(t.confirmados[0].nombre, 'Ana Perez');
  assert.equal((await A.baja(r[5].id, 'x'.repeat(64))).error, 'no_autorizado', 'no se puede bajar a otro');
  assert.ok((await A.baja(r[5].id, r[5].token)).ok);
  t = turnoDe(await A.estado(), 'sushi-a');
  assert.ok(t.confirmados.some((x) => x.id === w1.id), 'sube el primero de la espera'); assert.equal(t.espera.length, 1);
});

test('sushi y bartender excluyentes; se libera 30 min antes; nunca superpuestos', { skip }, async () => {
  const x = await A.anotar('ana.perez@wyeworks.com', 'bartender-a');
  assert.equal(x.error, 'excluyente'); assert.equal(x.desde, '16:30');
  await at('16:29'); assert.equal((await A.anotar('ana.perez@wyeworks.com', 'bartender-a')).error, 'excluyente');
  assert.equal((await A.anotar('sc@wyeworks.com', 'sushi-c')).estado, 'confirmado');
  await at('16:31');
  assert.equal((await A.anotar('sc@wyeworks.com', 'bartender-a')).error, 'superpuesto');
  const ex = await A.anotar('ana.perez@wyeworks.com', 'bartender-a');
  assert.equal(ex.estado, 'confirmado'); assert.equal(ex.via, 'excepcion');
  await at('12:00');
});

test('confirmar en un taller cancela la espera en el otro', { skip }, async () => {
  assert.equal((await A.anotar('ww@wyeworks.com', 'sushi-a')).estado, 'espera');
  assert.equal((await A.anotar('ww@wyeworks.com', 'bartender-b')).estado, 'confirmado');
  const yo = (await A.estado('ww@wyeworks.com')).yo.inscripciones;
  assert.deepEqual(yo.map((i) => i.taller), ['bartender']);
});

test('la baja de la organización también promueve', { skip }, async () => {
  for (let i = 1; i <= 15; i++) await A.anotar(`bc${i}@wyeworks.com`, 'bartender-c');
  const wc = await A.anotar('wc@wyeworks.com', 'bartender-c'); assert.equal(wc.estado, 'espera');
  const primero = turnoDe(await A.estado(), 'bartender-c').confirmados[0];
  assert.ok((await A.admin('baja', { id: primero.id })).ok);
  assert.ok(turnoDe(await A.estado(), 'bartender-c').confirmados.some((x) => x.id === wc.id));
});

test('cierre a la hora de inicio (anotarse y bajarse); la organización puede igual', { skip }, async () => {
  const yo = await A.anotar('cierre@wyeworks.com', 'sushi-b');
  await at('15:00'); assert.equal((await A.anotar('tarde@wyeworks.com', 'sushi-a')).error, 'cerrado');
  await at('16:00'); assert.equal((await A.baja(yo.id, yo.token)).error, 'cerrado');
  assert.equal((await A.admin('alta', { email: 'vip@wyeworks.com', turno: 'sushi-a' })).estado, 'confirmado');
  await at('12:00');
});

test('masajes: 32 por orden, después espera; abierto hasta las 18', { skip }, async () => {
  const m = [];
  for (let i = 1; i <= 33; i++) m.push(await A.anotar(`m${i}@wyeworks.com`, 'masajes'));
  assert.equal(m[31].estado, 'confirmado'); assert.equal(m[32].estado, 'espera');
  assert.equal((await A.anotar('ana.perez@wyeworks.com', 'masajes')).estado, 'espera', 'no es excluyente');
  await at('17:59'); assert.equal((await A.anotar('m99@wyeworks.com', 'masajes')).estado, 'espera');
  await at('18:00'); assert.equal((await A.anotar('m98@wyeworks.com', 'masajes')).error, 'cerrado');
  await at('12:00');
});

test('reintento con la misma clave: devuelve la misma inscripción, sin duplicar ni dar error', { skip }, async () => {
  const k = token();
  const a = await A.anotar('reintento@wyeworks.com', 'bartender-a', null, k);
  const b = await A.anotar('reintento@wyeworks.com', 'bartender-a', null, k);
  assert.equal(a.estado, 'confirmado'); assert.equal(b.id, a.id); assert.equal(b.repetido, true);
  assert.ok((await A.baja(a.id, k)).ok, 'la clave del celular sirve para bajarse');
  assert.equal((await A.anotar('reintento@wyeworks.com', 'bartender-a', null, 'corta')).error, 'token');
  const otro = await A.anotar('reintento2@wyeworks.com', 'bartender-a', null, token());
  assert.equal((await A.anotar('reintento2@wyeworks.com', 'bartender-a', null, token())).error, 'ya_anotado', 'otra clave no se hace pasar');
  assert.ok(otro.ok);
});

test('tarot: 30 por orden de anotación, después espera; abierto hasta las 20', { skip }, async () => {
  const r = [];
  for (let i = 1; i <= 31; i++) r.push(await A.anotar(`t${i}@wyeworks.com`, 'tarot'));
  assert.equal(r[29].estado, 'confirmado'); assert.equal(r[29].posicion, 30); assert.equal(r[30].estado, 'espera');
  assert.equal((await A.anotar('sc@wyeworks.com', 'tarot')).estado, 'espera', 'no es excluyente con los talleres');
  await at('19:59'); assert.equal((await A.anotar('t99@wyeworks.com', 'tarot')).estado, 'espera');
  await at('20:00'); assert.equal((await A.anotar('t98@wyeworks.com', 'tarot')).error, 'cerrado');
  await at('12:00');
});
