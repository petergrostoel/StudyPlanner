-- Studieplan – fag og projekter, sideintervaller, ISBN og læsetid.
-- Kør hele filen i Supabase: SQL Editor → New query → indsæt → Run.
-- Filen kan køres flere gange uden at gøre skade.
--
-- Hver bruger logger nu ind med sin egen konto og har én profil (en række i
-- kids). Reglerne "Egne rækker" sørger allerede for, at ingen kan se andres data.

-- ---------- Fag og projekter ----------
-- Tabellen curricula bruges nu til fag og projekter. deadline er fristen,
-- hvor alt i faget skal være læst (eksamen eller aflevering).
alter table public.curricula add column if not exists kind text not null default 'fag';
alter table public.curricula add column if not exists color text;
alter table public.curricula drop constraint if exists curricula_kind_check;
alter table public.curricula add constraint curricula_kind_check check (kind in ('fag', 'projekt'));

-- ---------- Bøger og tekster ----------
-- ranges: de sider der skal læses, fx [{"from":112,"to":148},{"from":211,"to":310}].
-- from_page og to_page er første og sidste side i alle intervallerne.
alter table public.books add column if not exists ranges jsonb;
alter table public.books add column if not exists isbn text;
alter table public.books add column if not exists author text;

-- ---------- Læsninger ----------
-- Antal sider der faktisk blev læst (sider uden for intervallerne tæller ikke).
alter table public.sessions add column if not exists pages integer;

-- ---------- Læsetid: regler for fuld, halv eller ingen læsetid ----------
create table if not exists public.day_rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kid_id      uuid not null references public.kids (id) on delete cascade,
  kind        text not null check (kind in ('weekday', 'period', 'day')),
  weekday     smallint check (weekday between 0 and 6),   -- 0 = søndag
  from_date   date,          -- ugedag: gælder fra (tom = altid); periode: fra; enkelt dag: datoen
  to_date     date,          -- ugedag: gælder til (tom = altid); periode: til
  day_type    text not null check (day_type in ('full', 'half', 'none')),
  label       text,
  deleted     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists day_rules_user_updated_idx on public.day_rules (user_id, updated_at);

drop trigger if exists day_rules_set_updated_at on public.day_rules;
create trigger day_rules_set_updated_at before insert or update on public.day_rules
  for each row execute function public.set_updated_at();

alter table public.day_rules enable row level security;
drop policy if exists "Egne rækker" on public.day_rules;
create policy "Egne rækker" on public.day_rules for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.day_rules to authenticated;
revoke all on table public.day_rules from anon;
