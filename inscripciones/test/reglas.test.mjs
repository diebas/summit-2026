// Reglas de inscripción sobre un Postgres real y descartable (no toca Supabase).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, api, turnoDe, token, REMOTE } from './db.mjs';

let db, A;
const at = (hhmm) => A.admin('config', { ahora: `2026-11-21 ${hhmm}:00-03` });
const mail = (x) => `${x}@wyeworks.com`;
const nombres = (lista) => lista.map((x) => x.nombre);
const fila = async (turno) => turnoDe(await A.estado(), turno);
const yo = async (x, taller) => (await A.estado(mail(x))).yo.inscripciones.find((i) => i.taller === taller);

before(async () => {
  if (REMOTE) return;
  db = await startDb(); A = api(db.anon);
  await at('12:00');
});
after(() => stopDb(db));
const skip = REMOTE ? 'solo con la base local (cambia la hora y reinicia datos)' : false;
const limpiar = () => A.admin('reiniciar');

test('seguridad: el rol público no lee tablas ni funciones internas', { skip }, async () => {
  for (const q of ['select * from insc.inscripciones', 'select * from insc.config', "select * from insc.fila('sushi-a')"]) {
    await assert.rejects(db.anon.query(q), /permission denied/, q);
  }
  assert.equal((await A.admin('lista', {}, 'mala')).error, 'no_admin');
});

test('solo mails @wyeworks.com; mail normalizado y nombre derivado', { skip }, async () => {
  await limpiar();
  assert.equal((await A.anotar('juan@gmail.com', 'sushi-a')).error, 'dominio');
  assert.equal((await A.anotar('juan@wyeworks.com.ar', 'sushi-a')).error, 'dominio');
  const r = await A.anotar('  Ana.Perez@WyeWorks.com ', 'sushi-a');
  assert.equal(r.estado, 'confirmado'); assert.equal(r.nombre, 'Ana Perez'); assert.equal(r.prioridad, 'normal');
  assert.equal((await A.anotar('dbaste@wyeworks.com', 'sushi-b', 'Diego Baste')).nombre, 'Diego Baste');
  assert.equal((await A.anotar('ana.perez@wyeworks.com', 'sushi-b')).error, 'ya_anotado', 'un solo turno por taller');
});

test('cupo, orden de llegada, espera y que suba el siguiente al bajarse', { skip }, async () => {
  await limpiar();
  const r = [];
  for (let i = 1; i <= 17; i++) r.push(await A.anotar(mail(`p${i}`), 'sushi-a'));
  assert.equal(r[14].estado, 'confirmado'); assert.equal(r[14].posicion, 15);
  assert.deepEqual([r[15].estado, r[15].posicion, r[16].posicion], ['espera', 1, 2]);
  assert.equal((await A.baja(r[4].id, 'x'.repeat(64))).error, 'no_autorizado', 'no se puede bajar a otro');
  assert.ok((await A.baja(r[4].id, r[4].token)).ok);
  const t = await fila('sushi-a');
  assert.equal(t.confirmados.length, 15); assert.ok(t.confirmados.some((x) => x.id === r[15].id), 'sube el primero de la espera');
  assert.deepEqual(nombres(t.espera), ['P17']);
});

test('se puede estar en los dos del par: la segunda anotación es provisoria', { skip }, async () => {
  await limpiar();
  const a = await A.anotar(mail('ana'), 'sushi-a'), b = await A.anotar(mail('ana'), 'bartender-b');
  assert.deepEqual([a.prioridad, b.prioridad], ['normal', 'provisoria']);
  assert.equal(b.estado, 'confirmado', 'con lugar libre entra igual');
  assert.equal((await A.anotar(mail('ana'), 'masajes')).prioridad, 'normal', 'otro par: normal');
  assert.equal((await A.anotar(mail('ana'), 'tarot')).prioridad, 'provisoria');
  assert.equal((await fila('bartender-b')).confirmados[0].prov, true, 'la lista marca las provisorias');
});

test('turno lleno: una normal desplaza a la última provisoria a la espera', { skip }, async () => {
  await limpiar();
  for (let i = 1; i <= 3; i++) await A.anotar(mail(`dob${i}`), 'sushi-a');                 // tienen sushi…
  for (let i = 1; i <= 3; i++) await A.anotar(mail(`dob${i}`), 'bartender-b');             // …y bartender provisorio
  for (let i = 1; i <= 12; i++) await A.anotar(mail(`b${i}`), 'bartender-b');               // 12 normales
  let t = await fila('bartender-b');
  assert.equal(t.confirmados.length, 15);
  assert.deepEqual(nombres(t.confirmados).slice(-3), ['Dob1', 'Dob2', 'Dob3'], 'provisorias al final, en orden de llegada');
  const n = await A.anotar(mail('nuevo'), 'bartender-b');
  assert.equal(n.estado, 'confirmado'); assert.equal(n.posicion, 13, 'entra delante de las provisorias');
  t = await fila('bartender-b');
  assert.deepEqual(nombres(t.espera), ['Dob3'], 'la última provisoria pasa a espera');
  assert.equal((await yo('dob3', 'bartender')).estado, 'espera');
  // una provisoria nueva va a la espera, detrás
  await A.anotar(mail('dob4'), 'sushi-b'); const p = await A.anotar(mail('dob4'), 'bartender-b');
  assert.deepEqual([p.estado, p.posicion], ['espera', 2]);
  // una normal nueva con el turno lleno: entra y desplaza; cuando ya no quedan provisorias con lugar, va primera en la espera
  for (let i = 13; i <= 14; i++) await A.anotar(mail(`b${i}`), 'bartender-b');
  assert.deepEqual(nombres((await fila('bartender-b')).espera), ['Dob1', 'Dob2', 'Dob3', 'Dob4']);
  const late = await A.anotar(mail('tarde'), 'bartender-b');
  assert.deepEqual([late.estado, late.posicion], ['espera', 1]);
  assert.deepEqual(nombres((await fila('bartender-b')).espera), ['Tarde', 'Dob1', 'Dob2', 'Dob3', 'Dob4']);
});

test('bajarse de la anotación normal convierte la provisoria en normal (y la adelanta)', { skip }, async () => {
  await limpiar();
  const s = await A.anotar(mail('ana'), 'sushi-a');
  await A.anotar(mail('ana'), 'bartender-b');
  for (let i = 1; i <= 15; i++) await A.anotar(mail(`b${i}`), 'bartender-b');
  assert.equal((await yo('ana', 'bartender')).estado, 'espera', 'desplazada por normales');
  assert.ok((await A.baja(s.id, s.token)).ok);
  const b = await yo('ana', 'bartender');
  assert.deepEqual([b.prioridad, b.estado, b.posicion], ['normal', 'espera', 1], 'pasa a normal: primera de la espera');
  await A.anotar(mail('x'), 'sushi-b'); await A.anotar(mail('x'), 'bartender-b');
  assert.deepEqual(nombres((await fila('bartender-b')).espera), ['Ana', 'X']);
});

test('después de que empieza el turno ya no se mueve nada', { skip }, async () => {
  await limpiar();
  await A.anotar(mail('dob'), 'sushi-a'); await A.anotar(mail('dob'), 'bartender-a');
  for (let i = 1; i <= 14; i++) await A.anotar(mail(`b${i}`), 'bartender-a');
  await at('17:00');
  assert.equal((await A.anotar(mail('tarde'), 'bartender-a')).error, 'cerrado');
  assert.equal((await yo('dob', 'bartender')).estado, 'confirmado');
  await at('12:00');
});

test('nunca dos turnos que se pisan; cierre a la hora de inicio; la organización puede igual', { skip }, async () => {
  await limpiar();
  assert.equal((await A.anotar(mail('sc'), 'sushi-c')).estado, 'confirmado');
  assert.equal((await A.anotar(mail('sc'), 'bartender-a')).error, 'superpuesto', 'sushi C y bartender A se pisan');
  assert.equal((await A.anotar(mail('sc'), 'bartender-b')).estado, 'confirmado', 'bartender B no se pisa');
  const yo1 = await A.anotar(mail('cierre'), 'sushi-b');
  await at('15:00'); assert.equal((await A.anotar(mail('tarde'), 'sushi-a')).error, 'cerrado');
  await at('16:00'); assert.equal((await A.baja(yo1.id, yo1.token)).error, 'cerrado');
  assert.equal((await A.admin('alta', { email: mail('vip'), turno: 'sushi-a' })).estado, 'confirmado');
  await at('12:00');
});

test('masajes y tarot: provisorias al final; se corren sus horarios; las que ya pasaron no se mueven', { skip }, async () => {
  await limpiar();
  for (let i = 1; i <= 4; i++) await A.anotar(mail(`t${i}`), 'masajes');                   // normales en masajes
  for (let i = 1; i <= 4; i++) await A.anotar(mail(`t${i}`), 'tarot');                     // provisorias en tarot
  let t = await fila('tarot');
  assert.deepEqual(t.confirmados.map((x) => x.hora), ['17:00', '17:06', '17:12', '17:18']);
  await A.anotar(mail('solo'), 'tarot');                                                   // normal: va primero
  t = await fila('tarot');
  assert.deepEqual(nombres(t.confirmados), ['Solo', 'T1', 'T2', 'T3', 'T4']);
  assert.equal(t.confirmados[1].hora, '17:06', 'T1 se corrió un turno');
  await at('17:07');                                                                       // a T1 (17:06) ya le tocó
  await A.anotar(mail('solo2'), 'tarot');
  t = await fila('tarot');
  assert.deepEqual(nombres(t.confirmados), ['Solo', 'T1', 'Solo2', 'T2', 'T3', 'T4'], 'no pasa delante de quien ya empezó');
  await at('12:00');
});

test('masajes: 32 lugares (de a 2 cada 15 min), después espera; abierto hasta las 18', { skip }, async () => {
  await limpiar();
  const m = [];
  for (let i = 1; i <= 33; i++) m.push(await A.anotar(mail(`m${i}`), 'masajes'));
  assert.equal(m[31].estado, 'confirmado'); assert.equal(m[32].estado, 'espera');
  const t = await fila('masajes');
  assert.deepEqual(t.confirmados.slice(0, 4).map((x) => x.hora), ['14:00', '14:00', '14:15', '14:15']);
  assert.equal(t.confirmados[31].hora, '17:45');
  await at('17:59'); assert.equal((await A.anotar(mail('m99'), 'masajes')).estado, 'espera');
  await at('18:00'); assert.equal((await A.anotar(mail('m98'), 'masajes')).error, 'cerrado');
  await at('12:00');
});

test('tarot: 30 lugares, uno cada 6 min; abierto hasta las 20', { skip }, async () => {
  await limpiar();
  const r = [];
  for (let i = 1; i <= 31; i++) r.push(await A.anotar(mail(`t${i}`), 'tarot'));
  assert.equal(r[29].posicion, 30); assert.equal(r[30].estado, 'espera');
  assert.equal((await fila('tarot')).confirmados[29].hora, '19:54');
  await at('20:00'); assert.equal((await A.anotar(mail('t98'), 'tarot')).error, 'cerrado');
  await at('12:00');
});

test('reintento con la misma clave: devuelve la misma inscripción, sin duplicar ni dar error', { skip }, async () => {
  await limpiar();
  const k = token();
  const a = await A.anotar(mail('reintento'), 'bartender-a', null, k);
  const b = await A.anotar(mail('reintento'), 'bartender-a', null, k);
  assert.equal(a.estado, 'confirmado'); assert.equal(b.id, a.id); assert.equal(b.repetido, true);
  assert.ok((await A.baja(a.id, k)).ok, 'la clave del celular sirve para bajarse');
  assert.equal((await A.anotar(mail('reintento'), 'bartender-a', null, 'corta')).error, 'token');
  const otro = await A.anotar(mail('reintento2'), 'bartender-a', null, token());
  assert.equal((await A.anotar(mail('reintento2'), 'bartender-a', null, token())).error, 'ya_anotado', 'otra clave no se hace pasar');
  assert.ok(otro.ok);
});
