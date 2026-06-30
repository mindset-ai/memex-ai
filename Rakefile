require "json"
require "fileutils"
require "uri"

namespace :mcp do
  desc "Authorize a local-server MCP token for Claude Code + Desktop (runs the device flow)"
  task :local do
    puts "Running installer against local server (http://localhost:8080)..."
    puts "Make sure pnpm dev:server is running first."
    puts ""
    exec("npx -y memex-ai install --api-base http://localhost:8080 --admin-base http://localhost:5173")
  end

  desc "Authorize an int-staging MCP token for Claude Code + Desktop (runs the device flow)"
  task :int do
    puts "Running installer against int.memex.ai..."
    puts ""
    exec("npx -y memex-ai install --api-base https://int.memex.ai")
  end
end

namespace :test do
  desc "Run React UI vitest suite"
  task :client do
    exec("pnpm --filter @memex/ui test")
  end

  desc "Run full server vitest suite (unit + integration + api + security + perf)"
  task :server do
    exec("pnpm --filter @memex/server test")
  end

  desc "Run server integration tests only (needs local Postgres)"
  task :integration do
    exec("pnpm --filter @memex/server test:integration")
  end

  desc "Run React UI Playwright e2e journeys (needs server + React UI running)"
  task :e2e do
    exec("pnpm --filter @memex/ui test:e2e")
  end
end

PROXY_PORT = 15_432

namespace :waitlist do
  desc "Show all waitlist signups"
  task :all do
    with_prod_db do |conninfo|
      exec %(PGPASSWORD="#{db_pass}" psql #{conninfo} -c "SELECT name, company, email, deployment, created_at FROM waitlist_entries ORDER BY created_at;")
    end
  end

  desc "Show only external (non-Mindset) waitlist signups"
  task :external do
    with_prod_db do |conninfo|
      exec %(PGPASSWORD="#{db_pass}" psql #{conninfo} -c "SELECT name, company, email, deployment, created_at FROM waitlist_entries WHERE email NOT LIKE '%@mindset.ai' ORDER BY created_at;")
    end
  end

  desc "Show waitlist signup count by deployment preference"
  task :stats do
    with_prod_db do |conninfo|
      exec %(PGPASSWORD="#{db_pass}" psql #{conninfo} -c "SELECT deployment, COUNT(*) AS signups FROM waitlist_entries GROUP BY deployment ORDER BY signups DESC;")
    end
  end

  desc "Show today's waitlist signups"
  task :today do
    with_prod_db do |conninfo|
      exec %(PGPASSWORD="#{db_pass}" psql #{conninfo} -c "SELECT name, company, email, deployment, created_at FROM waitlist_entries WHERE created_at::date = CURRENT_DATE ORDER BY created_at;")
    end
  end
end

# Resolve int/prod DB-access config from the SAME source as the deploy scripts:
# scripts/deploy-config.sh, which sources the gitignored scripts/deploy.<env>.env.
# ENV selects the target (defaults to "int", matching deploy-config.sh); run e.g.
# `ENV=prod rake waitlist:all` to hit prod. This keeps instance coordinates — GCP
# project, Cloud SQL instance, DB-password secret — out of tracked source. See
# scripts/deploy.env.example. Memoized so unrelated rake tasks never shell out.
def deploy_db_config
  @deploy_db_config ||= begin
    config = File.expand_path("scripts/deploy-config.sh", __dir__)
    # Route deploy-config's own stdout chatter to stderr; emit only the values we
    # need, NUL-delimited so a password with odd characters survives the trip.
    cmd = %(source "#{config}" >&2 && printf '%s\\0' "$CLOUD_SQL_INSTANCE_CONN" "$DB_USER" "$DB_NAME" "$DB_PASS")
    out = IO.popen(["bash", "-c", cmd], &:read)
    unless $?.success?
      abort "ERROR: could not load scripts/deploy-config.sh. Set ENV=int|prod and create " \
            "scripts/deploy.<env>.env from scripts/deploy.env.example before running DB tasks."
    end
    instance, user, name, password = out.split("\x00")
    { instance: instance, user: user, name: name, password: password }
  end
end

def db_pass
  deploy_db_config[:password]
end

def with_prod_db
  cfg = deploy_db_config
  proxy_pid = spawn("cloud-sql-proxy #{cfg[:instance]} --port #{PROXY_PORT}", %i[out err] => "/tmp/sql-proxy.log")
  sleep 3
  conninfo = "-h localhost -p #{PROXY_PORT} -U #{cfg[:user]} -d #{cfg[:name]}"
  yield conninfo
ensure
  Process.kill("TERM", proxy_pid) rescue nil
  Process.wait(proxy_pid) rescue nil
end

# Resolve the local dev DB from packages/server/.env (DATABASE_URL). Avoids the
# previous hardcoded `memex` on default port — most local setups override the
# DB name and port (e.g. `memex_dev` on 5433), and dropping `memex` left their
# actual DB untouched while reporting success.
def local_db_from_env
  env_file = File.expand_path("packages/server/.env", __dir__)
  unless File.exist?(env_file)
    abort "ERROR: #{env_file} not found. Create it (see CLAUDE.md Quick Start) before running db tasks."
  end

  raw = File.read(env_file)
            .lines
            .grep(/^\s*DATABASE_URL\s*=/)
            .last
  abort "ERROR: DATABASE_URL not found in #{env_file}." unless raw

  url = raw.split("=", 2).last.strip.gsub(/^["']|["']$/, "")
  uri = URI.parse(url)
  name = uri.path.delete_prefix("/")
  abort "ERROR: DATABASE_URL has no database name (#{url})." if name.empty?

  {
    name:     name,
    host:     uri.host || "localhost",
    port:     uri.port || 5432,
    user:     uri.user || "postgres",
    password: uri.password,
  }
end

namespace :db do
  desc "Drop and recreate the DATABASE_URL-targeted local database, run migrations"
  task :nuke do
    db = local_db_from_env

    # Kill any process holding a connection (e.g. dev server) on the API port.
    pids = `lsof -i :8080 -t 2>/dev/null`.strip
    unless pids.empty?
      puts "Stopping server (pid #{pids.split.join(', ')})..."
      system "kill #{pids}"
      sleep 1
    end

    conn = "-h #{db[:host]} -p #{db[:port]} -U #{db[:user]}"
    env  = db[:password] ? { "PGPASSWORD" => db[:password] } : {}

    puts "Dropping database #{db[:name]} on #{db[:host]}:#{db[:port]}..."
    system(env, "dropdb #{conn} --if-exists #{db[:name]}") or abort "dropdb failed"
    puts "Creating database #{db[:name]}..."
    system(env, "createdb #{conn} #{db[:name]}") or abort "createdb failed"
    puts "Running migrations..."
    system("pnpm --filter @memex/server db:migrate") or abort "migrate failed"
    puts "Done. Local database is fresh."
  end

  desc "List prod org namespaces (slug + memex/doc counts) to pick an exact NS= for clone_prod_org. ENV=prod required."
  task :list_orgs do
    with_prod_db do |conninfo|
      sql = "SELECT n.slug, count(DISTINCT m.id) AS memexes, count(DISTINCT d.id) AS docs " \
            "FROM namespaces n LEFT JOIN memexes m ON m.namespace_id = n.id " \
            "LEFT JOIN documents d ON d.memex_id = m.id " \
            "WHERE n.kind = 'org' GROUP BY n.slug ORDER BY docs DESC NULLS LAST;"
      system({ "PGPASSWORD" => db_pass }, "psql #{conninfo} -c \"#{sql}\"")
    end
  end

  # ── Sandbox: clone prod's schema + ONE org's data into the local DB ──────────
  # Reusable. EVERY run OBLITERATES the local DATABASE_URL database and rebuilds:
  #   • schema — a verbatim `pg_dump --schema-only` of prod (exact parity, incl.
  #     the __drizzle_migrations head, so local reports fully-migrated). Not
  #     "run local migrations and hope they match".
  #   • data   — ONLY the rows belonging to the target namespace's org + memexes.
  #     Tables carrying memex_id are discovered dynamically and scoped by it;
  #     child/identity tables are scoped explicitly (see `explicit` below);
  #     secrets/transport/global tables are left empty by design.
  # Prod safety: the only prod connection is the cloud-sql-proxy, which dies with
  # the `with_prod_db` block — the rebuilt local app has no path back to prod, and
  # sends no real email as long as POSTMARK_SERVER_TOKEN is unset (ConsoleEmailSender).
  #
  #   ENV=prod NS=<namespace-slug> ENABLE_LOGIN=you@example.com rake db:clone_prod_org
  #
  #   NS                  REQUIRED — org namespace slug to clone. No default. A missing,
  #                       malformed, or unknown slug aborts BEFORE the local DB is touched.
  #                       Discover valid slugs with `ENV=prod rake db:list_orgs`.
  #   ENABLE_LOGIN        email to mark verified+active for local login (optional)
  #   INCLUDE_CODE_INTEL  =1 to also pull repos + code-intel rows (default: off)
  desc "Obliterate local DB; rebuild as a schema-exact prod copy carrying ONLY one org's data. NS=<slug> + ENV=prod required."
  task :clone_prod_org do
    ns_slug    = (ENV["NS"] || "").strip
    login      = ENV["ENABLE_LOGIN"]
    code_intel = ENV["INCLUDE_CODE_INTEL"] == "1"
    work       = "/tmp/memex-clone"
    data_dir   = "#{work}/data"

    # Require an explicit namespace and validate its FORMAT up front (matches the
    # namespaces.slug CHECK). This rejects a missing/typo'd value before we start the
    # proxy or touch anything, and blocks SQL injection via the interpolated slug.
    if ns_slug.empty?
      abort "NS is required. Usage: ENV=prod NS=<namespace-slug> rake db:clone_prod_org\n" \
            "Discover valid slugs with: ENV=prod rake db:list_orgs"
    end
    unless ns_slug =~ /\A[a-z0-9][a-z0-9-]{0,38}\z/
      abort "NS='#{ns_slug}' is not a valid namespace slug (lowercase letters / digits / hyphens). See `ENV=prod rake db:list_orgs`."
    end

    local = local_db_from_env
    # Safety rail: this task DROPs its target. Never let that be a remote host.
    unless %w[localhost 127.0.0.1 ::1].include?(local[:host])
      abort "REFUSING: local DATABASE_URL host is '#{local[:host]}', not localhost. This task drops its target DB."
    end

    FileUtils.rm_rf(work)
    FileUtils.mkdir_p(data_dir)

    # Anchored subqueries (single resolved namespace slug → org/memex/doc sets).
    nsq  = "(SELECT id FROM namespaces WHERE slug = '#{ns_slug}')"
    orgq = "(SELECT id FROM orgs WHERE namespace_id IN #{nsq})"
    memq = "(SELECT id FROM memexes WHERE namespace_id IN #{nsq})"
    docq = "(SELECT id FROM documents WHERE memex_id IN #{memq})"

    # Tables WITHOUT memex_id, scoped explicitly. (memex_id tables auto-discovered.)
    explicit = {
      "namespaces"            => "id IN #{nsq}",
      "orgs"                  => "namespace_id IN #{nsq}",
      "memexes"               => "namespace_id IN #{nsq}",
      "org_memberships"       => "org_id IN #{orgq}",
      "org_consent_responses" => "org_id IN #{orgq}",
      "users"                 => "id IN (SELECT user_id FROM org_memberships WHERE org_id IN #{orgq}" \
                                 " UNION SELECT owner_user_id FROM namespaces WHERE id IN #{nsq}" \
                                 " UNION SELECT created_by_user_id FROM orgs WHERE namespace_id IN #{nsq})",
      "doc_sections"          => "doc_id IN #{docq}",
      "decision_deps"         => "decision_id IN (SELECT id FROM decisions WHERE memex_id IN #{memq})",
      "task_deps"             => "task_id IN (SELECT id FROM tasks WHERE memex_id IN #{memq})",
      "ac_parent_links"       => "ac_id IN (SELECT id FROM acs WHERE memex_id IN #{memq})",
      "task_satisfies_ac"     => "task_id IN (SELECT id FROM tasks WHERE memex_id IN #{memq})",
      "test_events"           => "ac_uid LIKE '#{ns_slug}/%'",
      "test_event_latest"     => "ac_uid LIKE '#{ns_slug}/%'",
      "conversations"         => "doc_id IN #{docq}",
      "messages"              => "conversation_id IN (SELECT id FROM conversations WHERE doc_id IN #{docq})",
    }

    # Left empty locally (secrets / transport / cross-tenant / global).
    skip = %w[
      auth_tokens mcp_tokens mcp_sessions oauth_clients oauth_authorization_codes
      oauth_refresh_tokens cli_auth_requests user_slack_tokens slack_user_cache
      domain_verification_tokens namespace_slug_reservations redirects
      waitlist_entries whats_new_entries whats_new_skips invite_tokens
      verified_domains org_discord_webhooks guide_content
    ]
    code_intel_tables = %w[
      repos repo_scope files symbols dependencies calls embeddings repo_endpoints
      repo_structure repo_patterns repo_domains repo_tech_stack test_coverage
      decision_file_coverage drift_signals mission_repos
    ]
    skip += code_intel_tables unless code_intel

    pass    = db_pass
    colmap  = {}   # table -> non-generated column list (reused on import)
    pulled  = {}   # table -> row count
    roles   = []
    extns   = []

    with_prod_db do |conninfo|
      penv = %(PGPASSWORD="#{pass}")
      q = ->(sql) { `#{penv} psql #{conninfo} -tAc "#{sql}"`.strip }

      ns_id = q.call("SELECT id FROM namespaces WHERE slug = '#{ns_slug}'")
      if ns_id.empty?
        abort "Namespace '#{ns_slug}' not found in prod — LOCAL DB UNTOUCHED. " \
              "List valid slugs with: ENV=prod rake db:list_orgs"
      end
      puts "Cloning namespace #{ns_slug} (#{ns_id}) from prod..."

      puts "1/4 dumping prod schema (public + drizzle; admin/backstage schema excluded)..."
      sh %(#{penv} pg_dump #{conninfo} -n public -n drizzle --schema-only --no-owner --no-privileges -f #{work}/schema.sql)
      # Migration ledger lives in the `drizzle` schema — pull its data so local
      # reports fully-migrated and never tries to re-run migrations over live objects.
      sh %(#{penv} pg_dump #{conninfo} -n drizzle --data-only --no-owner -f #{work}/drizzle-data.sql)

      # Non-superuser app roles RLS policies reference — recreate locally so the
      # schema (policies included) loads cleanly.
      roles = q.call(
        "SELECT string_agg(rolname, ' ') FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' " \
        "AND rolname NOT IN ('postgres','cloudsqladmin','cloudsqlsuperuser','cloudsqlagent','cloudsqliamuser','cloudsqlimportexport')"
      ).split
      # Extensions prod uses (e.g. vector) — pg_dump -n omits CREATE EXTENSION, so
      # we recreate them locally before loading the schema that references their types.
      extns = q.call("SELECT string_agg(extname, ' ') FROM pg_extension WHERE extname <> 'plpgsql'").split

      # Build the full scope map: memex_id tables (dynamic) + explicit, minus skip.
      mtables = q.call(
        "SELECT string_agg(c.table_name, ' ') FROM information_schema.columns c " \
        "JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name " \
        "WHERE c.table_schema='public' AND c.column_name='memex_id' AND t.table_type='BASE TABLE'"
      ).split
      scope = {}
      mtables.each { |t| scope[t] = "memex_id IN #{memq}" unless skip.include?(t) }
      explicit.each { |t, w| scope[t] = w unless skip.include?(t) }
      if code_intel
        repoq = "(SELECT id FROM repos WHERE memex_id IN #{memq})"
        %w[repo_scope files repo_endpoints repo_structure repo_patterns repo_domains repo_tech_stack mission_repos].each do |t|
          scope[t] = "repo_id IN #{repoq}"
        end
      end

      puts "2/4 exporting #{scope.size} scoped tables..."
      export_sql = []
      scope.keys.sort.each do |t|
        cols = q.call(
          "SELECT string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) " \
          "FROM information_schema.columns WHERE table_schema='public' AND table_name='#{t}' AND is_generated='NEVER'"
        )
        next if cols.empty? # not in prod (schema drift) — skip silently-but-logged below
        colmap[t] = cols
        export_sql << %(\\copy (SELECT #{cols} FROM #{t} WHERE #{scope[t]}) TO '#{data_dir}/#{t}.dat')
      end
      File.write("#{work}/export.sql", export_sql.join("\n") + "\n")
      sh %(#{penv} psql #{conninfo} -v ON_ERROR_STOP=1 -f #{work}/export.sql)

      colmap.keys.each do |t|
        f = "#{data_dir}/#{t}.dat"
        pulled[t] = File.exist?(f) ? File.foreach(f).count : 0
      end
    end

    # Rebuild local.
    conn = "-h #{local[:host]} -p #{local[:port]} -U #{local[:user]}"
    lenv = local[:password] ? { "PGPASSWORD" => local[:password] } : {}
    pids = `lsof -i :8080 -t 2>/dev/null`.strip
    system("kill #{pids}") unless pids.empty?

    puts "3/4 obliterating + recreating local #{local[:name]}..."
    system(lenv, "psql #{conn} -d postgres -v ON_ERROR_STOP=1 -c \"DROP DATABASE IF EXISTS #{local[:name]} WITH (FORCE);\"") or abort "drop failed"
    system(lenv, "createdb #{conn} #{local[:name]}") or abort "createdb failed"
    unless roles.empty?
      role_sql = roles.map { |r| "DO $$ BEGIN CREATE ROLE #{r} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;" }.join("\n")
      File.write("#{work}/roles.sql", role_sql + "\n")
      system(lenv, "psql #{conn} -d #{local[:name]} -f #{work}/roles.sql") or abort "role create failed"
    end
    # Recreate prod's extensions into the createdb-provided `public` schema BEFORE the
    # schema load (the dump references their types, e.g. public.vector, but omits CREATE EXTENSION).
    unless extns.empty?
      ext_sql = extns.map { |e| %(CREATE EXTENSION IF NOT EXISTS "#{e}" WITH SCHEMA public;) }.join("\n")
      File.write("#{work}/ext.sql", ext_sql + "\n")
      system(lenv, "psql #{conn} -d #{local[:name]} -v ON_ERROR_STOP=1 -f #{work}/ext.sql") or abort "extension create failed (is it installed in local PG?)"
    end
    # Reconcile the PG17 dump with the local server: strip GUCs PG16 rejects, and drop
    # the dump's `CREATE SCHEMA public` (public already exists from createdb + extensions).
    %w[schema.sql drizzle-data.sql].each do |f|
      path = "#{work}/#{f}"
      s = File.read(path)
      s = s.gsub(/^SET (transaction_timeout|idle_session_timeout) = .*\n/, "")
      s = s.gsub(/^CREATE SCHEMA public;\n/, "")
      File.write(path, s)
    end
    system(lenv, "psql #{conn} -d #{local[:name]} -v ON_ERROR_STOP=1 -f #{work}/schema.sql") or abort "schema load failed"
    system(lenv, "psql #{conn} -d #{local[:name]} -f #{work}/drizzle-data.sql") or abort "migration-ledger load failed"

    puts "4/4 loading data (FK triggers disabled for load)..."
    import_sql = ["SET session_replication_role = replica;"]
    colmap.keys.sort.each do |t|
      next if pulled[t].to_i.zero?
      import_sql << %(\\copy #{t} (#{colmap[t]}) FROM '#{data_dir}/#{t}.dat')
    end
    File.write("#{work}/import.sql", import_sql.join("\n") + "\n")
    system(lenv, "psql #{conn} -d #{local[:name]} -v ON_ERROR_STOP=1 -f #{work}/import.sql") or abort "data load failed"

    if login && !login.empty?
      system(lenv, "psql #{conn} -d #{local[:name]} -c \"UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), status='active' WHERE email = '#{login}';\"")
      puts "Login enabled for #{login} (verified + active). Sign in via the magic link — it prints to the SERVER TERMINAL (ConsoleEmailSender), no real email sent."
    end

    puts "\n── Clone complete: #{ns_slug} → local #{local[:name]} ──"
    pulled.reject { |_, n| n.to_i.zero? }.sort_by { |_, n| -n }.each { |t, n| puts format("  %-26s %6d rows", t, n) }
    empty = pulled.select { |_, n| n.to_i.zero? }.keys
    puts "  (no rows: #{empty.join(', ')})" unless empty.empty?
    puts "  (left empty by design: #{skip.size} secret/transport/global tables#{code_intel ? '' : ' incl. code-intel'})"
  end
end

