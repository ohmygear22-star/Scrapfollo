-- StarPulse persistence schema (V1 design §9, 2026-09-15 spec).
-- Dedicated database starpulse_db / least-privilege user starpulse_app.
-- Deployment on the droplet requires separate explicit owner approval.

BEGIN;

CREATE TABLE IF NOT EXISTS targets (
    id                  uuid primary key,
    platform            text not null,
    platform_username   text not null,
    platform_user_id    text,
    status              text not null,
    created_at          timestamptz not null,
    updated_at          timestamptz not null
);
CREATE UNIQUE INDEX IF NOT EXISTS targets_platform_username_key
    ON targets (platform, lower(platform_username));
CREATE UNIQUE INDEX IF NOT EXISTS targets_platform_user_id_key
    ON targets (platform, platform_user_id)
    WHERE platform_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS social_profiles (
    id                  uuid primary key,
    platform            text not null,
    platform_user_id    text,
    username            text not null,
    full_name           text,
    is_private          boolean,
    is_verified         boolean,
    profile_pic_url     text,
    first_seen_at       timestamptz not null,
    last_seen_at        timestamptz not null
);
CREATE INDEX IF NOT EXISTS social_profiles_platform_id_idx
    ON social_profiles (platform, platform_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS social_profiles_platform_username_key
    ON social_profiles (platform, lower(username))
    WHERE platform_user_id IS NULL;

CREATE TABLE IF NOT EXISTS scrape_runs (
    id                       uuid primary key,
    target_id                uuid not null references targets(id),
    started_at               timestamptz not null,
    completed_at             timestamptz,
    status                   text not null,
    requested_relationships  text[] not null,
    followers_complete       boolean,
    followers_termination    text,
    following_complete       boolean,
    following_termination    text,
    followers_count          bigint,
    following_count          bigint,
    results_collected        bigint not null,
    request_count            integer not null,
    failed_request_count     integer not null,
    retry_count              integer not null,
    bytes_transferred        bigint,
    runtime_ms               bigint,
    compute_units            numeric,
    proxy_cost               numeric,
    estimated_cost           numeric,
    cost_data_status         text not null,
    error_category           text
);
CREATE INDEX IF NOT EXISTS scrape_runs_target_time_idx
    ON scrape_runs (target_id, started_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
    id                    uuid primary key,
    target_id             uuid not null references targets(id),
    scrape_run_id         uuid not null unique references scrape_runs(id),
    captured_at           timestamptz not null,
    followers_count       bigint,
    following_count       bigint,
    followers_complete     boolean not null,
    following_complete     boolean not null,
    followers_is_baseline boolean not null default false,
    following_is_baseline boolean not null default false
);
CREATE INDEX IF NOT EXISTS snapshots_target_time_idx
    ON snapshots (target_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS staging_relationships (
    run_id               uuid not null references scrape_runs(id),
    relationship_type    text not null check (relationship_type in ('FOLLOWER', 'FOLLOWING')),
    dedupe_key           text not null,
    source_platform_id   text not null,
    related_platform_id  text,
    username             text not null,
    full_name            text,
    is_private           boolean,
    is_verified          boolean,
    profile_pic_url      text,
    position             bigint not null,
    scraped_at           timestamptz not null,
    primary key(run_id, relationship_type, dedupe_key)
);

CREATE TABLE IF NOT EXISTS relationship_edges (
    id                  uuid primary key,
    target_id           uuid not null references targets(id),
    related_profile_id  uuid not null references social_profiles(id),
    relationship_type   text not null check (relationship_type in ('FOLLOWER', 'FOLLOWING')),
    first_seen_at       timestamptz not null,
    last_seen_at        timestamptz not null,
    active              boolean not null
);
CREATE UNIQUE INDEX IF NOT EXISTS relationship_edges_identity_key
    ON relationship_edges (target_id, related_profile_id, relationship_type);
CREATE INDEX IF NOT EXISTS relationship_edges_active_idx
    ON relationship_edges (target_id, relationship_type) WHERE active;

CREATE TABLE IF NOT EXISTS snapshot_edges (
    snapshot_id          uuid not null references snapshots(id),
    relationship_edge_id uuid not null references relationship_edges(id),
    primary key(snapshot_id, relationship_edge_id)
);
CREATE INDEX IF NOT EXISTS snapshot_edges_edge_idx ON snapshot_edges (relationship_edge_id);

CREATE TABLE IF NOT EXISTS relationship_changes (
    id                    uuid primary key,
    target_id             uuid not null references targets(id),
    related_profile_id    uuid not null references social_profiles(id),
    relationship_type     text not null check (relationship_type in ('FOLLOWER', 'FOLLOWING')),
    change_type           text not null check (change_type in ('NEW_FOLLOWING', 'UNFOLLOWED', 'NEW_FOLLOWER', 'LOST_FOLLOWER')),
    previous_snapshot_id  uuid references snapshots(id),
    current_snapshot_id   uuid not null references snapshots(id),
    detected_at           timestamptz not null
);
CREATE INDEX IF NOT EXISTS relationship_changes_target_time_idx
    ON relationship_changes (target_id, detected_at DESC);

COMMIT;
