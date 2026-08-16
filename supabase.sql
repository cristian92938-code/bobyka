-- Bobyka: base de pedidos
create table if not exists public.pedidos (
  id uuid primary key,
  created_at timestamptz not null default now(),
  producto text not null,
  cantidad integer not null check (cantidad > 0),
  precio_unitario numeric(12,2) not null,
  total numeric(12,2) not null,
  nombre text not null,
  email text not null,
  telefono text,
  talle text,
  detalles text,
  archivo_path text not null,
  archivo_nombre text,
  archivo_tipo text,
  estado_pago text not null default 'pendiente',
  estado_pedido text not null default 'pendiente',
  pago_id text,
  preferencia_id text
);

create index if not exists pedidos_created_at_idx on public.pedidos(created_at desc);
create index if not exists pedidos_estado_pago_idx on public.pedidos(estado_pago);
create index if not exists pedidos_estado_pedido_idx on public.pedidos(estado_pedido);

alter table public.pedidos enable row level security;

-- Bucket privado para logos/diseños.
insert into storage.buckets (id, name, public)
values ('disenos', 'disenos', false)
on conflict (id) do update set public = false;

-- No creamos policies públicas. El backend usa SERVICE ROLE para acceder.
