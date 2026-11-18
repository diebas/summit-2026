# Inscripciones a talleres

Las listas de sushi, bartender y masajes viven en Supabase (Postgres). El mapa (`../index.html`) solo llama a cuatro funciones RPC; las tablas no son accesibles desde afuera.

| Archivo | Qué es |
|---|---|
| `supabase.sql` | Todo el esquema: tablas, reglas, permisos y talleres/turnos del evento. Se pega en Supabase → SQL Editor → Run. **Volver a correrlo borra las inscripciones.** |
| `test/` | Pruebas automáticas (ver abajo). |

## Reglas

- Solo mails `@wyeworks.com`. Una inscripción por persona y taller.
- Orden de llegada según la hora del servidor; cupo exacto aunque se anoten muchos a la vez.
- Lista de espera: cuando alguien se baja, sube el primero que pueda entrar.
- Sushi y bartender son excluyentes; 30 min antes de cada turno se libera para todos si quedan lugares. Nunca dos turnos superpuestos.
- Anotarse y bajarse: hasta la hora de inicio (masajes: hasta las 18:00).
- Para bajarse hace falta la clave que guardó el celular al anotarse. La clave la genera el celular antes de enviar, así que si la respuesta se pierde y se reintenta, la base devuelve la misma inscripción.
- La organización (clave de administración) puede ver mails, dar de alta/baja sin reglas, cargar la fecha y simular la hora para ensayos.

## Pruebas

```bash
cd inscripciones/test
npm install
npm test                 # reglas + concurrencia, en un Postgres 17 descartable (no toca Supabase)
CHROME_PATH=/ruta/a/chrome npm run test:pantalla   # el mapa en un celular simulado contra un Supabase falso
```

- **`reglas.test.mjs`**: permisos, dominio, cupos, espera, exclusividad y la media hora antes, superposición, cierres, masajes, reintentos con la misma clave.
- **`concurrencia.test.mjs`**: 60 personas a la vez por 15 lugares (exactamente 15 confirmados), bajas simultáneas, la misma persona en dos talleres a la vez, doble toque. Con `CARGA_N=120` prueba 120.
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
