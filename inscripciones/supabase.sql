-- =====================================================================
--  Summit 2026 · Inscripciones a talleres (Supabase / Postgres)
--  Pegar entero en Supabase → SQL Editor → Run. Se puede volver a correr:
--  borra y recrea todo (¡incluidas las inscripciones!).
-- =====================================================================

drop schema if exists insc cascade;
create schema insc;
revoke all on schema insc from public, anon, authenticated;

-- ---------- tablas (nadie las ve directo: solo las funciones de abajo) ----------
create table insc.config (k text primary key, v text);

create table insc.talleres (
  id        text primary key,
  nombre    text not null,
  tipo      text not null check (tipo in ('turnos','cola')),  -- cola = masajes: sin elegir horario
  grupo     text,             -- talleres del mismo grupo son excluyentes entre sí
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
  id            uuid primary key default gen_random_uuid(),
  taller_id     text not null references insc.talleres(id) on delete cascade,
  turno_id      text not null references insc.turnos(id) on delete cascade,
  email         text not null references insc.personas(email),
  estado        text not null check (estado in ('confirmado','espera','baja')),
  via           text not null default 'normal',   -- normal | excepcion | espera | admin
  creado        timestamptz not null default clock_timestamp(),  -- orden de llegada (hora del servidor)
  confirmado_en timestamptz,
  baja_en       timestamptz,
  baja_motivo   text,
  token_hash    text
);
-- una sola inscripción activa por persona y taller
create unique index insc_una_por_taller on insc.inscripciones (taller_id, email) where estado <> 'baja';
create index insc_turno on insc.inscripciones (turno_id, estado, creado);

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
$$ select case when t = 'infinity' then null else to_char(t at time zone 'America/Montevideo','HH24:MI') end $$;

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

-- ¿la persona puede ocupar un lugar en este turno? (exclusividad + superposición)
--   devuelve null si puede; si no, un jsonb de error
create function insc.impedimento(e text, ta insc.talleres, tu insc.turnos) returns jsonb language plpgsql stable as $$
declare v_ini timestamptz := insc.ts(tu.inicio); v_fin timestamptz := insc.ts(tu.fin);
        v_exc interval := make_interval(mins => coalesce(insc.cfg('excepcion_min'),'30')::int);
        v_otro text;
begin
  if ta.tipo = 'turnos' then
    select a.nombre into v_otro from insc.inscripciones i join insc.turnos t on t.id = i.turno_id join insc.talleres a on a.id = i.taller_id
     where i.email = e and i.estado = 'confirmado' and a.tipo = 'turnos' and i.turno_id <> tu.id
       and insc.ts(t.inicio) < v_fin and insc.ts(t.fin) > v_ini limit 1;
    if v_otro is not null then
      return insc.err('superpuesto', 'Ese horario se pisa con tu turno de '||v_otro||'.');
    end if;
  end if;
  if ta.grupo is not null then
    select a.nombre into v_otro from insc.inscripciones i join insc.talleres a on a.id = i.taller_id
     where i.email = e and i.estado = 'confirmado' and a.grupo = ta.grupo and a.id <> ta.id limit 1;
    if v_otro is not null and insc.ahora() < v_ini - v_exc then
      return insc.err('excluyente', 'Ya estás en '||v_otro||'. Si quedan lugares, este turno se habilita '||
             coalesce('a las '||insc.hhmm(v_ini - v_exc), 'media hora antes')||'.',
             jsonb_build_object('desde', insc.hhmm(v_ini - v_exc)));
    end if;
  end if;
  return null;
end $$;

-- sube gente de la lista de espera mientras haya lugar (por orden de llegada, salteando a quien ya no puede)
create function insc.promover(p_turno text) returns void language plpgsql as $$
declare tu insc.turnos; ta insc.talleres; r record; ocup int;
begin
  select * into tu from insc.turnos where id = p_turno;
  select * into ta from insc.talleres where id = tu.taller_id;
  if insc.cerrado(ta, tu) then return; end if;
  for r in select * from insc.inscripciones where turno_id = p_turno and estado = 'espera' order by creado loop
    select count(*) into ocup from insc.inscripciones where turno_id = p_turno and estado = 'confirmado';
    exit when ocup >= tu.cupo;
    perform 1 from insc.personas where email = r.email for update;      -- misma traba que "anotarme"
    continue when insc.impedimento(r.email, ta, tu) is not null;
    update insc.inscripciones set estado = 'confirmado', confirmado_en = insc.ahora(), via = 'espera' where id = r.id;
    if ta.grupo is not null then   -- confirmado acá: deja de esperar en los talleres excluyentes
      update insc.inscripciones i set estado = 'baja', baja_en = insc.ahora(), baja_motivo = 'confirmado en '||ta.nombre
        from insc.talleres a where a.id = i.taller_id and a.grupo = ta.grupo and a.id <> ta.id and i.email = r.email and i.estado = 'espera';
    end if;
  end loop;
end $$;

-- núcleo de "anotarme" (lo usan invitados y admin)
create function insc.anotar(p_email text, p_nombre text, p_turno text, p_admin boolean, p_token text default null) returns jsonb language plpgsql as $$
declare e text := lower(trim(coalesce(p_email,''))); n text := nullif(trim(coalesce(p_nombre,'')),'');
        v_dom text := coalesce(insc.cfg('dominio'),'wyeworks.com');
        tu insc.turnos; ta insc.talleres; v_ocup int; v_est text; v_via text := case when p_admin then 'admin' else 'normal' end;
        v_imp jsonb; v_tok text; v_nid uuid; v_pos int;
begin
  if e !~ ('^[a-z0-9._%+-]+@' || replace(v_dom,'.','\.') || '$') then
    return insc.err('dominio', 'Tiene que ser un mail @'||v_dom||'.');
  end if;
  select * into tu from insc.turnos where id = p_turno for update;      -- serializa el turno
  if not found then return insc.err('turno', 'Ese turno no existe.'); end if;
  select * into ta from insc.talleres where id = tu.taller_id;

  insert into insc.personas(email, nombre) values (e, coalesce(n, insc.nombre_de_mail(e)))
    on conflict (email) do update set nombre = coalesce(n, insc.personas.nombre);
  perform 1 from insc.personas where email = e for update;              -- serializa a la persona

  -- reintento del mismo celular (misma clave): devolver la inscripción que ya existe, sin error
  if p_token is not null then
    if length(p_token) < 32 then return insc.err('token', 'Clave inválida.'); end if;
    select id, estado into v_nid, v_est from insc.inscripciones
     where token_hash = insc.sha(p_token) and email = e and turno_id = tu.id and estado <> 'baja';
    if found then
      select count(*) into v_pos from insc.inscripciones where turno_id = tu.id and estado = v_est
         and creado <= (select creado from insc.inscripciones where id = v_nid);
      return jsonb_build_object('ok', true, 'id', v_nid, 'token', p_token, 'estado', v_est, 'posicion', v_pos,
                                'repetido', true, 'nombre', (select nombre from insc.personas where email = e));
    end if;
  end if;

  if not p_admin and insc.cerrado(ta, tu) then
    return insc.err('cerrado', case when ta.tipo = 'cola' then 'Ya terminó el horario.' else 'Este turno ya empezó.' end);
  end if;
  if exists (select 1 from insc.inscripciones where taller_id = ta.id and email = e and estado <> 'baja') then
    return insc.err('ya_anotado', 'Ya estás anotado/a en '||ta.nombre||'.');
  end if;

  select count(*) into v_ocup from insc.inscripciones where turno_id = tu.id and estado = 'confirmado';
  if p_admin then
    v_est := 'confirmado';
  else
    v_imp := insc.impedimento(e, ta, tu);
    if v_imp is not null then return v_imp; end if;
    if ta.grupo is not null and exists (select 1 from insc.inscripciones i join insc.talleres a on a.id = i.taller_id
          where i.email = e and i.estado = 'confirmado' and a.grupo = ta.grupo and a.id <> ta.id) then
      if v_ocup >= tu.cupo then return insc.err('lleno', 'No quedan lugares en este turno.'); end if;
      v_via := 'excepcion';                                                -- entra por la media hora antes
    end if;
    if v_ocup < tu.cupo then v_est := 'confirmado';
    elsif ta.espera then v_est := 'espera';
    else return insc.err('lleno', 'No quedan lugares.'); end if;
  end if;

  v_tok := coalesce(p_token, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
  insert into insc.inscripciones(taller_id, turno_id, email, estado, via, confirmado_en, token_hash)
    values (ta.id, tu.id, e, v_est, v_via, case when v_est = 'confirmado' then insc.ahora() end, insc.sha(v_tok))
    returning id into v_nid;
  if v_est = 'confirmado' and ta.grupo is not null and v_via <> 'excepcion' then
    update insc.inscripciones i set estado = 'baja', baja_en = insc.ahora(), baja_motivo = 'confirmado en '||ta.nombre
      from insc.talleres a where a.id = i.taller_id and a.grupo = ta.grupo and a.id <> ta.id and i.email = e and i.estado = 'espera';
  end if;
  select count(*) into v_pos from insc.inscripciones where turno_id = tu.id and estado = v_est and creado <= (select creado from insc.inscripciones where id = v_nid);
  return jsonb_build_object('ok', true, 'id', v_nid, 'token', v_tok, 'estado', v_est, 'posicion', v_pos, 'via', v_via,
                            'nombre', (select nombre from insc.personas where email = e));
end $$;

create function insc.dar_baja(p_id uuid, p_motivo text, p_admin boolean, p_token text) returns jsonb language plpgsql as $$
declare r insc.inscripciones; tu insc.turnos; ta insc.talleres;
begin
  select * into r from insc.inscripciones where id = p_id;
  if not found then return insc.err('no_existe', 'No encuentro esa inscripción.'); end if;
  if not p_admin and (r.token_hash is null or r.token_hash <> insc.sha(p_token)) then
    return insc.err('no_autorizado', 'Solo te podés desanotar desde el celular con el que te anotaste. Pedíselo a la organización.');
  end if;
  select * into tu from insc.turnos where id = r.turno_id for update;
  select * into ta from insc.talleres where id = tu.taller_id;
  select * into r from insc.inscripciones where id = p_id for update;
  if r.estado = 'baja' then return jsonb_build_object('ok', true, 'estado', 'baja'); end if;
  if not p_admin and insc.cerrado(ta, tu) then
    return insc.err('cerrado', 'El turno ya empezó: ya no te podés desanotar.');
  end if;
  update insc.inscripciones set estado = 'baja', baja_en = insc.ahora(), baja_motivo = p_motivo where id = p_id;
  if r.estado = 'confirmado' then perform insc.promover(tu.id); end if;
  return jsonb_build_object('ok', true, 'estado', 'baja');
end $$;

-- =====================================================================
--  API pública (lo único que puede llamar el mapa)
-- =====================================================================

-- estado de todo: cupos y nombres; si viene p_email, también "lo mío"
create function public.insc_estado(p_email text default null) returns jsonb
language plpgsql stable security definer set search_path = insc, public as $$
declare e text := lower(trim(coalesce(p_email,''))); exc interval := make_interval(mins => coalesce(insc.cfg('excepcion_min'),'30')::int);
begin
  return jsonb_build_object(
    'ahora', insc.ahora(), 'fecha', insc.cfg('fecha'), 'dominio', coalesce(insc.cfg('dominio'),'wyeworks.com'),
    'excepcion_min', coalesce(insc.cfg('excepcion_min'),'30')::int, 'simulado', coalesce(insc.cfg('ahora'),'') <> '',
    'talleres', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'nombre', a.nombre, 'tipo', a.tipo, 'grupo', a.grupo, 'pin', a.pin, 'espera', a.espera,
        'slot_min', a.slot_min, 'por_slot', a.por_slot,
        'turnos', (select jsonb_agg(jsonb_build_object(
            'id', t.id, 'nombre', t.nombre, 'inicio', to_char(t.inicio,'HH24:MI'), 'fin', to_char(t.fin,'HH24:MI'), 'cupo', t.cupo,
            'cerrado', insc.cerrado(a, t), 'desbloqueo', insc.hhmm(insc.ts(t.inicio) - exc),
            'desbloqueado', insc.ahora() >= insc.ts(t.inicio) - exc,
            'confirmados', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'nombre', p.nombre) order by i.creado)
                 from insc.inscripciones i join insc.personas p on p.email = i.email where i.turno_id = t.id and i.estado = 'confirmado'), '[]'),
            'espera', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'nombre', p.nombre) order by i.creado)
                 from insc.inscripciones i join insc.personas p on p.email = i.email where i.turno_id = t.id and i.estado = 'espera'), '[]')
          ) order by t.orden, t.inicio) from insc.turnos t where t.taller_id = a.id)
      ) order by a.orden) from insc.talleres a), '[]'),
    'yo', case when e = '' then null else jsonb_build_object(
        'email', e, 'nombre', (select nombre from insc.personas where email = e),
        'inscripciones', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'taller', i.taller_id, 'turno', i.turno_id, 'estado', i.estado, 'via', i.via) order by i.creado)
             from insc.inscripciones i where i.email = e and i.estado <> 'baja'), '[]')) end
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
      'id', i.id, 'taller', i.taller_id, 'turno', i.turno_id, 'email', i.email, 'nombre', p.nombre, 'estado', i.estado, 'via', i.via,
      'creado', i.creado, 'baja_en', i.baja_en, 'baja_motivo', i.baja_motivo) order by i.creado)
      from insc.inscripciones i join insc.personas p on p.email = i.email), '[]'));
  elsif p_accion = 'baja' then
    return insc.dar_baja((p_args->>'id')::uuid, 'baja por la organización', true, null);
  elsif p_accion = 'alta' then
    return insc.anotar(p_args->>'email', p_args->>'nombre', p_args->>'turno', true);
  elsif p_accion = 'config' then
    if p_args ? 'fecha' then insert into insc.config values ('fecha', p_args->>'fecha') on conflict (k) do update set v = excluded.v; end if;
    if p_args ? 'ahora' then insert into insc.config values ('ahora', p_args->>'ahora') on conflict (k) do update set v = excluded.v; end if;
    if p_args ? 'cupo' then update insc.turnos set cupo = (p_args->>'cupo')::int where id = p_args->>'turno';
                           perform insc.promover(p_args->>'turno'); end if;
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
  ('fecha', ''),                 -- AAAA-MM-DD: se carga desde el editor del mapa (Inscripciones → Fecha)
  ('ahora', ''),                 -- solo para ensayos: simula la hora. Dejar vacío el día del evento.
  ('excepcion_min', '30'),
  ('admin_hash', 'd0fd00cd45b6ef0424af6ab4ac26c2a0fd42b26ff96f1aa3c4981d9d8f40444d');

insert into insc.talleres (id, nombre, tipo, grupo, pin, espera, slot_min, por_slot, orden) values
  ('sushi',     'Taller de sushi',     'turnos', 'talleres', 'pmwbe779b', true, null, null, 1),
  ('bartender', 'Taller de bartender', 'turnos', 'talleres', 'pmwbe662u', true, null, null, 2),
  ('masajes',   'Masajes',             'cola',   null,       'p7',        true, 15,   2,    3),
  ('tarot',     'Tarot',               'cola',   null,       'p2',        true, 6,    1,    4);

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
