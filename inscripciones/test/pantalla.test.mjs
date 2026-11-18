// Prueba de pantalla: el mapa publicado (../../index.html) en un celular simulado, contra el Supabase de prueba.
// Necesita Chrome: usa CHROME_PATH si está definido; si no, el que descarga puppeteer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer';
import { startFake } from './fake-supabase.mjs';
import { api, ADMIN_KEY } from './db.mjs';

const here = path.dirname(new URL(import.meta.url).pathname), root = path.join(here, '..', '..');
const THREE = path.join(here, 'node_modules', 'three');
let fake, web, browser, page, A, perdidas = 0;

before(async () => {
  fake = await startFake({ port: 8791 }); A = api(fake.db.anon);
  for (let i = 1; i <= 15; i++) await A.anotar(`lleno.${i}@wyeworks.com`, 'bartender-b');   // turno lleno de antemano
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace(/https:\/\/cdnjs[^"]*three\.min\.js/, '/three/build/three.min.js')
    .replace(/https:\/\/cdn\.jsdelivr\.net[^"]*OrbitControls\.js/, '/three/examples/js/controls/OrbitControls.js');
  const data = JSON.parse(fs.readFileSync(path.join(root, 'data.json'), 'utf8')); data.insc = { url: fake.url, key: 'anon-key' };
  web = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/' || u === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
    if (u === '/data.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(data)); }
    if (u.startsWith('/three/')) { const f = path.join(THREE, u.slice(7)); if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(f)); } }
    res.writeHead(404); res.end();
  }).listen(8792);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage();
  // el 3D no importa para esta prueba: lo dibujamos a ~2 cuadros por segundo para que el navegador simulado responda rápido
  await page.evaluateOnNewDocument(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => setTimeout(() => raf(cb), 450); });
  page.on('pageerror', (e) => console.log('   [error en la página]', e.message));
  await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  // la primera anotación de "red mala" se procesa en el servidor, pero al celular no le llega la respuesta
  await page.setRequestInterception(true);
  page.on('request', async (r) => {
    if (r.url().endsWith('/rpc/insc_anotarme') && r.method() === 'POST' && (await page.evaluate(() => window.__redMala === true).catch(() => false)) && perdidas === 0) {
      perdidas++;
      await fetch(r.url(), { method: 'POST', headers: r.headers(), body: r.postData() });   // llega al servidor…
      return r.abort('connectionreset');                                                  // …pero la respuesta se pierde
    }
    r.continue();
  });
  await page.goto('http://localhost:8792/', { waitUntil: 'load' });
  await page.waitForSelector('#scroll');
});
after(async () => { await browser?.close(); web?.close(); await fake?.stop(); });

const texto = (sel) => page.$eval(sel, (e) => e.innerText);
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 40000 }); await page.$eval(sel, (e) => e.click()); };
const esperarTexto = (sel, re, timeout = 40000) => page.waitForFunction((s, src) => { const e = document.querySelector(s); return e && new RegExp(src, 'i').test(e.innerText); }, { timeout, polling: 250 }, sel, re.source);
const mias = () => page.evaluate(() => JSON.parse(localStorage.getItem('lascarretas-insc') || '{}').mias || []);

test('aparece la pestaña Anotarme y pide el mail', async () => {
  await page.evaluate(() => { const t = document.getElementById('toggle'); if (/Ver/.test(t.textContent)) t.click(); });
  await click('[data-tab="anotarme"]');
  await page.waitForSelector('#insc-mail');
});

test('rechaza un mail que no es de WyeWorks; con el mail correcto completa el nombre', async () => {
  await page.type('#insc-mail', 'diego@gmail.com'); await click('#insc-login button[type=submit]');
  await esperarTexto('.ins-msg', /@wyeworks\.com/);
  await page.$eval('#insc-mail', (e) => { e.value = ''; });
  await page.type('#insc-mail', 'diego.baste@wyeworks.com');
  assert.equal(await page.$eval('#insc-name', (e) => e.value), 'Diego Baste');
  await click('#insc-login button[type=submit]');
  await esperarTexto('.ins-sess', /Diego Baste/);
});

test('anotarse en sushi: confirmado y bloquea bartender hasta media hora antes', async () => {
  await page.waitForSelector('[data-turno="sushi-a"]:not([disabled])');
  await click('[data-turno="sushi-a"]');
  await esperarTexto('.ins-mine', /Confirmado/);
  const turnos = await page.$$eval('.ins-turno', (xs) => xs.map((x) => x.innerText.replace(/\s+/g, ' ')));
  assert.ok(turnos.some((t) => /Turno A · 17:00–17:45.*Se libera a las 16:30/.test(t)), turnos.join('\n'));
});

test('confirmado: botones para agregar al calendario (iPhone: .ics publicado; también Google Calendar)', async () => {
  await page.waitForSelector('.ins-cal a');
  const links = await page.$$eval('.ins-cal a', (as) => as.map((a) => a.href));
  assert.ok(links.includes('https://diebas.github.io/summit-2026/cal/sushi-a.ics'), links.join('\n'));
  const g = links.find((h) => h.startsWith('https://calendar.google.com/'));
  assert.ok(g && g.includes('dates=20261121T180000Z/20261121T184000Z'), g);
});

test('otra persona en el mismo celular queda en lista de espera de un turno lleno', async () => {
  await click('#insc-add'); await page.type('#insc-mail', 'ana.lopez@wyeworks.com'); await click('#insc-login button[type=submit]');
  await page.waitForFunction(() => /Ana Lopez/.test(document.querySelector('.ins-sess')?.innerText) && document.querySelector('[data-turno="bartender-b"]:not([disabled])'), { timeout: 40000, polling: 250 });
  await click('[data-turno="bartender-b"]');
  await esperarTexto('.ins-msg', /lista de espera \(nº 1\)/);
});

test('red mala: la respuesta se pierde, el reintento recupera la misma inscripción y la clave queda en el celular', async () => {
  await page.evaluate(() => { window.__redMala = true; });
  await page.waitForSelector('[data-turno="masajes"]:not([disabled])');
  await click('[data-turno="masajes"]');
  await esperarTexto('.ins-msg', /Tenés tu lugar/, 60000);
  assert.equal(perdidas, 1, 'se simuló una respuesta perdida');
  const yo = (await A.estado('ana.lopez@wyeworks.com')).yo.inscripciones.filter((i) => i.taller === 'masajes');
  assert.equal(yo.length, 1, 'una sola inscripción en la base');
  assert.ok((await mias()).some((m) => m.id === yo[0].id), 'el celular guardó la clave');
  await page.evaluate(() => { window.__redMala = false; });
});

test('cada uno se baja solo desde su celular', async () => {
  await page.$$eval('.pchip', (bs) => bs.find((b) => b.textContent === 'Diego').click());
  await page.waitForFunction(() => /Diego Baste/.test(document.querySelector('.ins-sess')?.innerText) && document.querySelector('[data-baja]'), { timeout: 40000, polling: 250 });
  await click('[data-baja]'); await click('[data-baja]');               // dos toques: «¿Seguro?»
  await esperarTexto('.ins-msg', /te desanotaste/);
  assert.equal((await A.estado('diego.baste@wyeworks.com')).yo.inscripciones.length, 0);
});

test('la tarjeta del pin de Sushi lleva a Anotarme', async () => {
  await page.evaluate(() => document.getElementById('toggle').click());
  await page.waitForFunction(() => [...document.querySelectorAll('.pin')].some((e) => /Sushi/.test(e.textContent)));
  await page.$$eval('.pin', (ps) => ps.find((e) => /Sushi/.test(e.textContent)).click());
  await click('#selcard [data-insc]');
  assert.equal(await texto('.tabs [aria-pressed=true]'), 'Anotarme');
});

test('panel de la organización: conecta con la clave y muestra las listas con mails', async () => {
  await page.goto('http://localhost:8792/#editar', { waitUntil: 'load' });
  await click('[data-et="insc"]');
  await page.waitForSelector('#ia-admin');
  await page.$eval('#ia-admin', (e, k) => { e.value = k; }, ADMIN_KEY);
  await click('#ia-connect');
  await page.waitForFunction(() => document.querySelectorAll('.ins-admin').length > 0, { timeout: 40000, polling: 250 });
  const listas = await page.$$eval('.ins-admin summary', (xs) => xs.map((x) => x.innerText.replace(/\s+/g, ' ')));
  assert.ok(listas.some((t) => /Turno B 18:00 · 15\/15 · 1 en espera/.test(t)), listas.join('\n'));
});
