// Los .ics publicados en GitHub Pages (../../cal) coinciden con los turnos de supabase.sql y tienen la alarma de 15 minutos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SQL } from './db.mjs';

const here = path.dirname(new URL(import.meta.url).pathname), CAL = path.join(here, '..', '..', 'cal');
const FECHA = '2026-11-21';
const talleres = Object.fromEntries([...SQL.matchAll(/\('([\w-]+)',\s*'([^']+)',\s*'(turnos|cola)',\s*(?:'[^']*'|null),\s*'([^']*)',\s*\w+,\s*(\w+),/g)]
  .map((m) => [m[1], { nombre: m[2], tipo: m[3], slot: +m[5] }]));
const turnos = [...SQL.matchAll(/\('([\w-]+)',\s*'([\w-]+)',\s*'([^']+)',\s*'(\d\d:\d\d)',\s*'(\d\d:\d\d)',\s*(\d+),\s*\d+\)/g)]
  .map((m) => ({ id: m[1], taller: m[2], nombre: m[3], inicio: m[4], fin: m[5] }));
const utc = (hhmm) => { const d = new Date(`${FECHA}T${hhmm}:00-03:00`); return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
const leer = (f) => fs.readFileSync(path.join(CAL, f), 'utf8');
const campo = (ics, k) => (ics.match(new RegExp(`^${k}:(.*)$`, 'm')) || [])[1]?.replace(/\r$/, '');

test('hay un .ics por turno con hora correcta (Montevideo = UTC-3) y alarma 15 min antes', () => {
  assert.ok(turnos.length >= 7);
  for (const t of turnos.filter((t) => talleres[t.taller].tipo === 'turnos')) {
    const ics = leer(`${t.id}.ics`);
    assert.equal(campo(ics, 'DTSTART'), utc(t.inicio), t.id); assert.equal(campo(ics, 'DTEND'), utc(t.fin), t.id);
    assert.match(ics, /^TRIGGER:-PT15M\r$/m); assert.match(campo(ics, 'SUMMARY'), new RegExp(t.nombre));
    assert.ok(ics.split('\n').slice(0, -1).every((l) => l.endsWith('\r')), 'líneas con CRLF');
  }
});

test('masajes: un .ics por cada turno estimado de 15 minutos', () => {
  for (const t of turnos.filter((t) => talleres[t.taller].tipo === 'cola')) {
    const a = talleres[t.taller], [h0, m0] = t.inicio.split(':').map(Number), [h1, m1] = t.fin.split(':').map(Number);
    let n = 0;
    for (let m = h0 * 60 + m0; m < h1 * 60 + m1; m += a.slot) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(m % 60).padStart(2, '0'), ics = leer(`${t.taller}-${hh}${mm}.ics`);
      assert.equal(campo(ics, 'DTSTART'), utc(`${hh}:${mm}`)); assert.match(ics, /tentativo/); n++;
    }
    assert.equal(n, 16);
  }
});
