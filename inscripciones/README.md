# Inscripciones a talleres

Las listas de sushi, bartender y masajes viven en Supabase (Postgres). El mapa (`../index.html`) solo llama a cuatro funciones RPC; las tablas no son accesibles desde afuera.

| Archivo | Qué es |
|---|---|
| `supabase.sql` | Todo el esquema: tablas, reglas, permisos y talleres/turnos del evento. Se pega en Supabase → SQL Editor → Run. **Volver a correrlo borra las inscripciones.** |
| `test/` | Pruebas automáticas (ver abajo). |

## Reglas

- Solo mails `@wyeworks.com`. Una inscripción por persona y taller.
- Talleres en pares: **sushi/bartender** y **tarot/masajes**. Te podés anotar en los dos del par, pero tu primera anotación es **normal** y la segunda **provisoria**.
- En cada turno las normales van delante de las provisorias; dentro de cada grupo, por orden de llegada (hora del servidor). Los primeros `cupo` tienen lugar; el resto está en espera.
- Si llega una normal a un turno lleno, la última provisoria pasa a espera. Puede pasar hasta que empieza el turno (masajes/tarot: hasta el horario estimado de esa persona).
- Si te bajás de tu anotación normal, la provisoria del otro taller del par pasa a normal.
- Nunca dos turnos que se pisan. Anotarse y bajarse: hasta la hora de inicio (masajes y tarot: hasta el fin).
- Para bajarse hace falta la clave que guardó el celular al anotarse. La clave la genera el celular antes de enviar, así que si la respuesta se pierde y se reintenta, la base devuelve la misma inscripción.
- La organización (clave de administración) puede ver mails, dar de alta/baja sin reglas, cargar la fecha y simular la hora para ensayos.

## Pruebas

```bash
cd inscripciones/test
npm install
npm test                 # reglas + concurrencia, en un Postgres 17 descartable (no toca Supabase)
CHROME_PATH=/ruta/a/chrome npm run test:pantalla   # el mapa en un celular simulado contra un Supabase falso
```

- **`reglas.test.mjs`**: permisos, dominio, cupos, espera, prioridad normal/provisoria y desplazamiento, provisoria que pasa a normal, superposición, cierres, masajes y tarot (incluido que no se mueve a quien ya le tocó), reintentos con la misma clave.
- **`concurrencia.test.mjs`**: 60 personas a la vez por 15 lugares (exactamente 15 con lugar), bajas simultáneas, la misma persona en los dos del par a la vez (una normal y una provisoria), 20 normales a la vez contra un turno lleno de provisorias, doble toque. Con `CARGA_N=120` prueba 120.
- **`pantalla.test.mjs`**: entrar con el mail, anotarse, lista de espera, dos personas en el mismo celular, respuesta perdida por red mala, bajarse, botón de la tarjeta del pin, panel de la organización.

### Prueba de carga contra el Supabase real

```bash
DATABASE_URL='postgres://postgres:<contraseña de la base>@db.lhdtfvfpojdkhqvouebs.supabase.co:5432/postgres' \
INSC_ADMIN_KEY='<clave de administración>' npm run test:carga
```

Crea un taller de prueba `zz-carga`, lo usa y lo borra; no toca los talleres reales ni la hora. Las pruebas de reglas no corren contra Supabase (cambian la hora y reinician datos).

### Probar el mapa a mano sin Supabase

```bash
npm run servidor     # Supabase falso en http://localhost:8790 (clave "anon-key"), hora simulada 12:00
```
