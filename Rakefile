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
  desc "Run React UI (admin) vitest suite"
  task :client do
    exec("pnpm --filter @memex/admin test")
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
    exec("pnpm --filter @memex/admin test:e2e")
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
end

