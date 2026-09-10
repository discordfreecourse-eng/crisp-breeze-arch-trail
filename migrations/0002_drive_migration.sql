-- One-time Google Drive copy queue. Unowned (single-operator tool).
create table if not exists google_account (
  id            text primary key default 'default',
  email         text,
  access_token  text,
  refresh_token text,
  token_expiry  timestamptz,
  scope         text,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists oauth_state (
  state      text primary key,
  created_at timestamptz not null default now()
);

create table if not exists jobs (
  id                 text primary key,
  status             text not null default 'draft',
  source_filename    text,
  dest_folder_name   text not null default 'Raw',
  dest_folder_id     text,
  concurrency        integer not null default 5,
  daily_budget_bytes bigint not null default 644245094400,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  completed_at       timestamptz,
  error              text
);

create table if not exists extracted_links (
  id         text primary key,
  job_id     text not null references jobs (id) on delete cascade,
  url        text not null,
  drive_id   text not null,
  kind_hint  text not null default 'unknown',
  unique (job_id, drive_id)
);
create index if not exists extracted_links_job_idx on extracted_links (job_id);

create table if not exists source_items (
  id               text primary key,
  job_id           text not null references jobs (id) on delete cascade,
  drive_id         text not null,
  parent_drive_id  text,
  name             text not null,
  mime_type        text not null,
  kind             text not null,
  size_bytes       bigint,
  file_count       integer not null default 0,
  total_size_bytes bigint not null default 0,
  selected         boolean not null default true,
  path             text not null default '',
  web_view_link    text,
  unique (job_id, drive_id)
);
create index if not exists source_items_job_idx on source_items (job_id);
create index if not exists source_items_parent_idx on source_items (job_id, parent_drive_id);

create table if not exists copy_queue (
  id               text primary key,
  job_id           text not null references jobs (id) on delete cascade,
  source_file_id   text not null,
  source_name      text not null,
  mime_type        text,
  size_bytes       bigint,
  dest_parent_path text not null default '',
  dest_folder_id   text,
  dest_file_id     text,
  status           text not null default 'pending',
  attempts         integer not null default 0,
  last_error       text,
  next_retry_at    timestamptz,
  claimed_at       timestamptz,
  claimed_by       text,
  copied_at        timestamptz
);
create unique index if not exists copy_queue_job_source_idx
  on copy_queue (job_id, source_file_id);
create unique index if not exists copy_queue_global_copied_idx
  on copy_queue (source_file_id) where dest_file_id is not null;
create index if not exists copy_queue_claim_idx
  on copy_queue (job_id, status, next_retry_at);

create table if not exists dest_folders (
  job_id         text not null,
  relative_path  text not null,
  drive_id       text not null,
  primary key (job_id, relative_path)
);

create table if not exists copy_events (
  id          serial primary key,
  job_id      text,
  bytes       bigint not null default 0,
  occurred_at timestamptz not null default now()
);
create index if not exists copy_events_time_idx on copy_events (occurred_at);

create table if not exists job_logs (
  id         serial primary key,
  job_id     text not null,
  level      text not null default 'info',
  message    text not null,
  created_at timestamptz not null default now()
);
create index if not exists job_logs_job_idx on job_logs (job_id, id desc);

create table if not exists settings (
  key   text primary key,
  value text not null
);
