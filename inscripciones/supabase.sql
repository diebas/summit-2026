-- =====================================================================
--  Summit 2026 · Inscripciones a talleres (Supabase / Postgres)
--  Pegar entero en Supabase → SQL Editor → Run. Se puede volver a correr:
--  borra y recrea todo (¡incluidas las inscripciones!).
--
--  Reglas
--  · Talleres en pares (sushi/bartender, tarot/masajes). Te podés anotar en los dos del par,
--    pero tu PRIMERA anotación del par es "normal" y la SEGUNDA es "provisoria".
--  · En cada turno las normales van delante de las provisorias; dentro de cada grupo, por orden de llegada.
--    Los primeros "cupo" tienen lugar (confirmado); el resto está en espera.
--  · Si llega una normal a un turno lleno, la última provisoria pasa a espera. Eso puede pasar
--    hasta que empieza el turno (en masajes/tarot: hasta el horario estimado de esa persona).
--  · Si te bajás de tu anotación normal, la provisoria del otro taller del par pasa a normal.
--  · Nunca dos turnos que se pisan. Anotarse y bajarse: hasta la hora de inicio (masajes/tarot: hasta el fin).
-- =====================================================================

drop function if exists public.insc_estado(text);
drop function if exists public.insc_anotarme(text,text,text,text);
drop function if exists public.insc_anotarme(text,text,text);
drop function if exists public.insc_desanotarme(uuid,text);
drop function if exists public.insc_admin(text,text,jsonb);
drop schema if exists insc cascade;
create schema insc;
revoke all on schema insc from public, anon, authenticated;

-- ---------- tablas (nadie las ve directo: solo las funciones de abajo) ----------
create table insc.config (k text primary key, v text);

create table insc.talleres (
  id        text primary key,
  nombre    text not null,
  tipo      text not null check (tipo in ('turnos','cola')),  -- cola = sin elegir horario (masajes, tarot)
  grupo     text,             -- talleres del mismo grupo forman un par (prioridad normal/provisoria)
  pin       text,             -- id del pin en el mapa
  espera    boolean not null default true,
  slot_min  int,              -- cola: minutos por turno
  por_slot  int,              -- cola: personas por turno
  orden     int not null default 0
);

create table insc.turnos (
  id        text primary key,
  taller_id text not null references insc.talleres(id) on delete cascade,
  nombre    text not null,
  inicio    time not null,
  fin       time not null,
  cupo      int  not null check (cupo > 0),
  orden     int  not null default 0
);

create table insc.personas (
  email  text primary key,
  nombre text not null,
  creado timestamptz not null default now()
);

create table insc.inscripciones (
  id          uuid primary key default gen_random_uuid(),
  taller_id   text not null references insc.talleres(id) on delete cascade,
  turno_id    text not null references insc.turnos(id) on delete cascade,
  email       text not null references insc.personas(email),
  estado      text not null default 'activa' check (estado in ('activa','baja')),
  prioridad   text not null default 'normal' check (prioridad in ('normal','provisoria')),
  pos         double precision not null,          -- lugar en la fila del turno (se renumera 1..n)
  via         text not null default 'normal',     -- normal | admin
  creado      timestamptz not null default clock_timestamp(),   -- hora del servidor
  baja_en     timestamptz,
  baja_motivo text,
  token_hash  text
);
-- una sola inscripción activa por persona y taller
create unique index insc_una_por_taller on insc.inscripciones (taller_id, email) where estado = 'activa';
create index insc_turno on insc.inscripciones (turno_id, estado, pos);

alter table insc.config        enable row level security;
alter table insc.talleres      enable row level security;
alter table insc.turnos        enable row level security;
alter table insc.personas      enable row level security;
alter table insc.inscripciones enable row level security;

-- ---------- ayudantes internos ----------
create function insc.cfg(p text) returns text language sql stable as
$$ select v from insc.config where k = p $$;

create function insc.ahora() returns timestamptz language sql stable as
$$ select coalesce(nullif(insc.cfg('ahora'),'')::timestamptz, now()) $$;

-- hora del día del evento → instante real en Montevideo ('infinity' si todavía no hay fecha)
create function insc.ts(t time) returns timestamptz language sql stable as $$
  select case when coalesce(insc.cfg('fecha'),'') = '' then 'infinity'::timestamptz
              else ((insc.cfg('fecha'))::date + t) at time zone 'America/Montevideo' end
$$;

create function insc.hhmm(t timestamptz) returns text language sql stable as
$$ select case when t is null or t = 'infinity' then null else to_char(t at time zone 'America/Montevideo','HH24:MI') end $$;

create function insc.sha(t text) returns text language sql immutable as
$$ select encode(sha256(convert_to(coalesce(t,''),'UTF8')),'hex') $$;

create function insc.nombre_de_mail(e text) returns text language sql immutable as
$$ select initcap(regexp_replace(split_part(e,'@',1), '[._-]+', ' ', 'g')) $$;

create function insc.err(code text, msg text, extra jsonb default '{}') returns jsonb language sql immutable as
$$ select jsonb_build_object('ok',false,'error',code,'msg',msg) || extra $$;

create function insc.es_admin(p_key text) returns boolean language sql stable as
$$ select coalesce(insc.sha(p_key) = insc.cfg('admin_hash'), false) $$;

-- ¿se cerró el turno? (turnos: al empezar; cola: al terminar el horario)
create function insc.cerrado(ta insc.talleres, tu insc.turnos) returns boolean language sql stable as
$$ select insc.ahora() >= case when ta.tipo = 'cola' then insc.ts(tu.fin) else insc.ts(tu.inicio) end $$;

-- la fila de un turno: orden, si tiene lugar o está en espera, y a qué hora le toca
create function insc.fila(p_turno text)
returns table (id uuid, email text, prioridad text, rn int, estado text, num int, hora timestamptz)
language sql stable as $$
  with t as (select tu.*, ta.tipo, ta.slot_min, ta.por_slot from insc.turnos tu join insc.talleres ta on ta.id = tu.taller_id where tu.id = p_turno),
       f as (select i.id, i.email, i.prioridad, row_number() over (order by i.pos, i.creado)::int rn
               from insc.inscripciones i where i.turno_id = p_turno and i.estado = 'activa')
  select f.id, f.email, f.prioridad, f.rn,
         case when f.rn <= t.cupo then 'confirmado' else 'espera' end,
         case when f.rn <= t.cupo then f.rn else f.rn - t.cupo end,
         case when f.rn > t.cupo then null
              when t.tipo = 'cola' then insc.ts(t.inicio) + make_interval(mins => ((f.rn - 1) / greatest(coalesce(t.por_slot,1),1)) * coalesce(t.slot_min,15))
              else insc.ts(t.inicio) end
    from f, t
$$;

-- lugar donde entra alguien en la fila: provisoria al final; normal delante de la primera
-- provisoria a la que todavía no le tocó (las que ya empezaron no se mueven)
create function insc.lugar_para(p_turno text, p_prio text) returns double precision language plpgsql stable as $$
declare v_next double precision; v_prev double precision;
begin
  if p_prio = 'normal' then
    select i.pos into v_next from insc.fila(p_turno) f join insc.inscripciones i on i.id = f.id
     where f.prioridad = 'provisoria' and (f.hora is null or f.hora > insc.ahora())
     order by f.rn limit 1;
    if v_next is not null then
      select max(pos) into v_prev from insc.inscripciones where turno_id = p_turno and estado = 'activa' and pos < v_next;
      return case when v_prev is null then v_next - 1 else (v_prev + v_next) / 2 end;
    end if;
  end if;
  return coalesce((select max(pos) from insc.inscripciones where turno_id = p_turno and estado = 'activa'), 0) + 1;
end $$;

create function insc.renumerar(p_turno text) returns void language sql as $$
  update insc.inscripciones i set pos = f.rn from insc.fila(p_turno) f where i.id = f.id and i.pos <> f.rn
$$;

-- ¿esta persona ya está anotada en el otro taller del par?
create function insc.tiene_par(e text, ta insc.talleres) returns boolean language sql stable as $$
  select ta.grupo is not null and exists (select 1 from insc.inscripciones i join insc.talleres a on a.id = i.taller_id
          where i.email = e and i.estado = 'activa' and a.grupo = ta.grupo and a.id <> ta.id)
$$;

-- núcleo de "anotarme" (lo usan invitados y admin)
create function insc.anotar(p_email text, p_nombre text, p_turno text, p_admin boolean, p_token text default null) returns jsonb language plpgsql as $$
declare e text := lower(trim(coalesce(p_email,''))); n text := nullif(trim(coalesce(p_nombre,'')),'');
        v_dom text := coalesce(insc.cfg('dominio'),'wyeworks.com');
        tu insc.turnos; ta insc.talleres; v_prio text; v_tok text; v_nid uuid; v_otro text; r record;
begin
  if e !~ ('^[a-z0-9._%+-]+@' || replace(v_dom,'.','\.') || '$') then
    return insc.err('dominio', 'Tiene que ser un mail @'||v_dom||'.');
  end if;
  if not exists (select 1 from insc.turnos where id = p_turno) then return insc.err('turno', 'Ese turno no existe.'); end if;

  -- trabas siempre en el mismo orden (persona, después turno) para que nunca se crucen
  insert into insc.personas(email, nombre) values (e, coalesce(n, insc.nombre_de_mail(e)))
    on conflict (email) do update set nombre = coalesce(n, insc.personas.nombre);
  perform 1 from insc.personas where email = e for update;
  select * into tu from insc.turnos where id = p_turno for update;
  select * into ta from insc.talleres where id = tu.taller_id;

  -- reintento del mismo celular (misma clave): devolver la inscripción que ya existe, sin error
  if p_token is not null then
    if length(p_token) < 32 then return insc.err('token', 'Clave inválida.'); end if;
    select id into v_nid from insc.inscripciones where token_hash = insc.sha(p_token) and email = e and turno_id = tu.id and estado = 'activa';
    if found then
      select * into r from insc.fila(tu.id) f where f.id = v_nid;
      return jsonb_build_object('ok', true, 'id', v_nid, 'token', p_token, 'estado', r.estado, 'posicion', r.num, 'prioridad', r.prioridad,
                                'repetido', true, 'nombre', (select nombre from insc.personas where email = e));
    end if;
  end if;

  if not p_admin and insc.cerrado(ta, tu) then
    return insc.err('cerrado', case when ta.tipo = 'cola' then 'Ya terminó el horario.' else 'Este turno ya empezó.' end);
  end if;
  if exists (select 1 from insc.inscripciones where taller_id = ta.id and email = e and estado = 'activa') then
    return insc.err('ya_anotado', 'Ya estás anotado/a en '||ta.nombre||'.');
  end if;
  if ta.tipo = 'turnos' then   -- nunca dos turnos que se pisan
    select a.nombre into v_otro from insc.inscripciones i join insc.turnos t on t.id = i.turno_id join insc.talleres a on a.id = i.taller_id
     where i.email = e and i.estado = 'activa' and a.tipo = 'turnos'
       and insc.ts(t.inicio) < insc.ts(tu.fin) and insc.ts(t.fin) > insc.ts(tu.inicio) limit 1;
    if v_otro is not null then return insc.err('superpuesto', 'Ese horario se pisa con tu turno de '||v_otro||'.'); end if;
  end if;
  if not p_admin and not ta.espera and (select count(*) from insc.fila(tu.id) f where f.estado = 'confirmado') >= tu.cupo then
    return insc.err('lleno', 'No quedan lugares.');
  end if;

  v_prio := case when not p_admin and insc.tiene_par(e, ta) then 'provisoria' else 'normal' end;
  v_tok := coalesce(p_token, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
  insert into insc.inscripciones(taller_id, turno_id, email, prioridad, pos, via, token_hash)
    values (ta.id, tu.id, e, v_prio, insc.lugar_para(tu.id, v_prio), case when p_admin then 'admin' else 'normal' end, insc.sha(v_tok))
    returning id into v_nid;
  perform insc.renumerar(tu.id);
  select * into r from insc.fila(tu.id) f where f.id = v_nid;
  return jsonb_build_object('ok', true, 'id', v_nid, 'token', v_tok, 'estado', r.estado, 'posicion', r.num, 'prioridad', v_prio,
                            'nombre', (select nombre from insc.personas where email = e));
end $$;

create function insc.dar_baja(p_id uuid, p_motivo text, p_admin boolean, p_token text) returns jsonb language plpgsql as $$
declare r insc.inscripciones; tu insc.turnos; ta insc.talleres; o record;
begin
  select * into r from insc.inscripciones where id = p_id;
  if not found then return insc.err('no_existe', 'No encuentro esa inscripción.'); end if;
  if not p_admin and (r.token_hash is null or r.token_hash <> insc.sha(p_token)) then
    return insc.err('no_autorizado', 'Solo te podés desanotar desde el celular con el que te anotaste. Pedíselo a la organización.');
  end if;
  -- trabas: persona, después los turnos que se tocan (este y los del par), en orden
  perform 1 from insc.personas where email = r.email for update;
  perform 1 from insc.turnos where id in (select r.turno_id union select i.turno_id from insc.inscripciones i where i.email = r.email and i.estado = 'activa')
    order by id for update;
  select * into r from insc.inscripciones where id = p_id;
  select * into tu from insc.turnos where id = r.turno_id;
  select * into ta from insc.talleres where id = tu.taller_id;
  if r.estado = 'baja' then return jsonb_build_object('ok', true, 'estado', 'baja'); end if;
  if not p_admin and insc.cerrado(ta, tu) then
    return insc.err('cerrado', 'El turno ya empezó: ya no te podés desanotar.');
  end if;
  update insc.inscripciones set estado = 'baja', baja_en = insc.ahora(), baja_motivo = p_motivo where id = p_id;
  perform insc.renumerar(tu.id);
  -- si ya no está en ningún otro del par, su provisoria pasa a normal (y se adelanta en esa fila)
  if ta.grupo is not null then
    for o in select i.id, i.turno_id, i.taller_id from insc.inscripciones i join insc.talleres a on a.id = i.taller_id
              where i.email = r.email and i.estado = 'activa' and i.prioridad = 'provisoria' and a.grupo = ta.grupo loop
      if not insc.tiene_par(r.email, (select x from insc.talleres x where x.id = o.taller_id)) then
        update insc.inscripciones set prioridad = 'normal' where id = o.id;
        update insc.inscripciones set pos = insc.lugar_para(o.turno_id, 'normal') where id = o.id;
        perform insc.renumerar(o.turno_id);
      end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'estado', 'baja');
end $$;

-- =====================================================================
--  API pública (lo único que puede llamar el mapa)
-- =====================================================================

-- estado de todo: cupos y nombres (en orden de la fila); si viene p_email, también "lo mío"
create function public.insc_estado(p_email text default null) returns jsonb
language plpgsql stable security definer set search_path = insc, public as $$
declare e text := lower(trim(coalesce(p_email,'')));
begin
  return jsonb_build_object(
    'ahora', insc.ahora(), 'fecha', insc.cfg('fecha'), 'dominio', coalesce(insc.cfg('dominio'),'wyeworks.com'),
    'simulado', coalesce(insc.cfg('ahora'),'') <> '',
    'talleres', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'nombre', a.nombre, 'tipo', a.tipo, 'grupo', a.grupo, 'pin', a.pin, 'espera', a.espera,
        'slot_min', a.slot_min, 'por_slot', a.por_slot,
        'turnos', (select jsonb_agg(jsonb_build_object(
            'id', t.id, 'nombre', t.nombre, 'inicio', to_char(t.inicio,'HH24:MI'), 'fin', to_char(t.fin,'HH24:MI'), 'cupo', t.cupo,
            'cerrado', insc.cerrado(a, t),
            'confirmados', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nombre', p.nombre, 'prov', f.prioridad = 'provisoria', 'hora', insc.hhmm(f.hora)) order by f.rn)
                 from insc.fila(t.id) f join insc.personas p on p.email = f.email where f.estado = 'confirmado'), '[]'),
            'espera', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nombre', p.nombre, 'prov', f.prioridad = 'provisoria') order by f.rn)
                 from insc.fila(t.id) f join insc.personas p on p.email = f.email where f.estado = 'espera'), '[]')
          ) order by t.orden, t.inicio) from insc.turnos t where t.taller_id = a.id)
      ) order by a.orden) from insc.talleres a), '[]'),
    'yo', case when e = '' then null else jsonb_build_object(
        'email', e, 'nombre', (select nombre from insc.personas where email = e),
        'inscripciones', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'taller', i.taller_id, 'turno', i.turno_id, 'estado', f.estado,
               'posicion', f.num, 'prioridad', i.prioridad, 'hora', insc.hhmm(f.hora), 'via', i.via) order by i.creado)
             from insc.inscripciones i cross join lateral insc.fila(i.turno_id) f
            where f.id = i.id and i.email = e and i.estado = 'activa'), '[]')) end
  );
end $$;

-- p_token: clave que genera el celular antes de enviar; si el pedido se reintenta, la base reconoce la misma inscripción
create function public.insc_anotarme(p_email text, p_turno text, p_nombre text default null, p_token text default null) returns jsonb
language sql security definer set search_path = insc, public as
$$ select insc.anotar(p_email, p_nombre, p_turno, false, p_token) $$;

create function public.insc_desanotarme(p_id uuid, p_token text) returns jsonb
language sql security definer set search_path = insc, public as
$$ select insc.dar_baja(p_id, 'se bajó', false, p_token) $$;

-- ---------- administración (requiere la clave de admin) ----------
create function public.insc_admin(p_key text, p_accion text, p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = insc, public as $$
begin
  if not insc.es_admin(p_key) then return insc.err('no_admin', 'Clave de administración incorrecta.'); end if;
  if p_accion = 'lista' then
    return jsonb_build_object('ok', true, 'inscripciones', coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'taller', i.taller_id, 'turno', i.turno_id, 'email', i.email, 'nombre', p.nombre,
      'estado', coalesce(f.estado, 'baja'), 'posicion', f.num, 'prioridad', i.prioridad, 'hora', insc.hhmm(f.hora), 'via', i.via,
      'creado', i.creado, 'baja_en', i.baja_en, 'baja_motivo', i.baja_motivo) order by i.turno_id, f.rn nulls last, i.creado)
      from insc.inscripciones i join insc.personas p on p.email = i.email
      left join lateral (select * from insc.fila(i.turno_id) x where x.id = i.id) f on true), '[]'));
  elsif p_accion = 'baja' then
    return insc.dar_baja((p_args->>'id')::uuid, 'baja por la organización', true, null);
  elsif p_accion = 'alta' then
    return insc.anotar(p_args->>'email', p_args->>'nombre', p_args->>'turno', true);
  elsif p_accion = 'config' then
    if p_args ? 'fecha' then insert into insc.config values ('fecha', p_args->>'fecha') on conflict (k) do update set v = excluded.v; end if;
    if p_args ? 'ahora' then insert into insc.config values ('ahora', p_args->>'ahora') on conflict (k) do update set v = excluded.v; end if;
    if p_args ? 'cupo' then update insc.turnos set cupo = (p_args->>'cupo')::int where id = p_args->>'turno'; end if;
    return jsonb_build_object('ok', true, 'fecha', insc.cfg('fecha'), 'ahora', insc.cfg('ahora'));
  elsif p_accion = 'reiniciar' then      -- borra todas las inscripciones (para después del ensayo)
    delete from insc.inscripciones; delete from insc.personas;
    return jsonb_build_object('ok', true);
  end if;
  return insc.err('accion', 'Acción desconocida.');
end $$;

-- ---------- permisos: el mapa solo puede ejecutar estas 4 funciones ----------
revoke all on all tables    in schema insc from public, anon, authenticated;
revoke all on all functions in schema insc from public, anon, authenticated;
revoke all on function public.insc_estado(text), public.insc_anotarme(text,text,text,text),
                       public.insc_desanotarme(uuid,text), public.insc_admin(text,text,jsonb) from public;
grant execute on function public.insc_estado(text), public.insc_anotarme(text,text,text,text),
                          public.insc_desanotarme(uuid,text), public.insc_admin(text,text,jsonb) to anon, authenticated;

-- =====================================================================
--  Datos del evento
-- =====================================================================
insert into insc.config values
  ('dominio', 'wyeworks.com'),
  ('fecha', '2026-11-21'),       -- AAAA-MM-DD (también se cambia desde el editor del mapa → Inscripciones)
  ('ahora', ''),                 -- solo para ensayos: simula la hora. Dejar vacío el día del evento.
  ('admin_hash', 'd0fd00cd45b6ef0424af6ab4ac26c2a0fd42b26ff96f1aa3c4981d9d8f40444d');

insert into insc.talleres (id, nombre, tipo, grupo, pin, espera, slot_min, por_slot, orden) values
  ('sushi',     'Taller de sushi',     'turnos', 'talleres',  'pmwbe779b', true, null, null, 1),
  ('bartender', 'Taller de bartender', 'turnos', 'talleres',  'pmwbe662u', true, null, null, 2),
  ('masajes',   'Masajes',             'cola',   'bienestar', 'p7',        true, 15,   2,    3),
  ('tarot',     'Tarot',               'cola',   'bienestar', 'p2',        true, 6,    1,    4);

insert into insc.turnos (id, taller_id, nombre, inicio, fin, cupo, orden) values
  ('sushi-a',     'sushi',     'Turno A', '15:00', '15:40', 15, 1),
  ('sushi-b',     'sushi',     'Turno B', '16:00', '16:40', 15, 2),
  ('sushi-c',     'sushi',     'Turno C', '17:00', '17:40', 15, 3),
  ('bartender-a', 'bartender', 'Turno A', '17:00', '17:45', 15, 1),
  ('bartender-b', 'bartender', 'Turno B', '18:00', '18:45', 15, 2),
  ('bartender-c', 'bartender', 'Turno C', '19:00', '19:45', 15, 3),
  ('masajes',     'masajes',   'Masajes', '14:00', '18:00', 32, 1),
  ('tarot',       'tarot',     'Tarot',   '17:00', '20:00', 30, 1);

-- funciones internas con search_path fijo (recomendación del asesor de seguridad de Supabase)
do $$ declare r record; begin
  for r in select p.oid::regprocedure f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='insc' loop
    execute format('alter function %s set search_path = insc, public, pg_temp', r.f);
  end loop; end $$;
