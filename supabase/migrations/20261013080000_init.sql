-- Studieplan – databaseopsætning til Supabase.
-- Kør hele filen i Supabase: SQL Editor → New query → indsæt → Run.
--
-- Én familiekonto (forælderens login) ejer alle rækker. Børnene vælges i appen.
-- Alle tabeller har updated_at og deleted, så appen kan synkronisere sin
-- offline-database: den henter kun rækker ændret siden sidst, og sletninger
-- er "bløde", så de også når frem til de andre enheder.

-- Hold updated_at opdateret automatisk. clock_timestamp() giver hver række sit
-- eget tidspunkt, også når mange gemmes i samme kald.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

-- ---------- Børn ----------
create table if not exists public.kids (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null,
  grade       text,
  color       text,
  -- fx {"maxMinutesPerDay": 45, "studyDays": [1,2,3,4,5], "freeFrom": "16:30"}
  settings    jsonb not null default '{}'::jsonb,
  deleted     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- Pensum (med samlet frist) ----------
create table if not exists public.curricula (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kid_id      uuid not null references public.kids (id) on delete cascade,
  title       text not null,
  deadline    date,
  deleted     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- Bøger og tekster (med evt. egen frist) ----------
create table if not exists public.books (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kid_id         uuid not null references public.kids (id) on delete cascade,
  curriculum_id  uuid references public.curricula (id) on delete set null,
  title          text not null,
  subject        text,
  from_page      integer not null check (from_page >= 0),
  to_page        integer not null,
  current_page   integer,          -- sidste side der er læst
  deadline       date,             -- tom = brug pensummets samlede frist
  deleted        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (to_page >= from_page)
);

-- ---------- Læsninger (grundlag for læsefarten) ----------
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kid_id      uuid not null references public.kids (id) on delete cascade,
  book_id     uuid not null references public.books (id) on delete cascade,
  start_page  integer not null,   -- første side der blev læst
  end_page    integer not null,   -- siden man nåede til
  minutes     integer not null check (minutes > 0),
  studied_at  timestamptz not null default now(),
  deleted     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Indeks, triggere, adgang og Row Level Security for alle fire tabeller.
do $$
declare
  t text;
begin
  foreach t in array array['kids', 'curricula', 'books', 'sessions'] loop
    execute format('create index if not exists %1$s_user_updated_idx on public.%1$I (user_id, updated_at)', t);

    execute format('drop trigger if exists %1$s_set_updated_at on public.%1$I', t);
    execute format('create trigger %1$s_set_updated_at before insert or update on public.%1$I
                    for each row execute function public.set_updated_at()', t);

    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Egne rækker" on public.%I', t);
    execute format('create policy "Egne rækker" on public.%I for all to authenticated
                    using ((select auth.uid()) = user_id)
                    with check ((select auth.uid()) = user_id)', t);

    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    execute format('revoke all on table public.%I from anon', t);
  end loop;
end;
$$;
