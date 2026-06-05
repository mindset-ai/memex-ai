import { statSync } from "node:fs";
import "dotenv/config";
import { ingest } from "./ingest.ts";
import { closeDb } from "@memex/server/db/connection";

function usage(): never {
  console.log("Usage:");
  console.log("  tsx src/index.ts --account <accountId> <repo_name> <folder_path> [<folder_path2> ...]");
  console.log("");
  console.log("Environment:");
  console.log("  DATABASE_URL   Memex Postgres connection string (required)");
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 3) usage();

  let accountId: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--account") {
      accountId = argv[++i] ?? null;
    } else {
      positional.push(arg);
    }
  }

  if (!accountId) {
    console.error("Missing required --account <accountId>");
    usage();
  }

  if (positional.length < 2) usage();

  const repoName = positional[0]!;
  const folders = positional.slice(1);
  for (const f of folders) {
    try {
      if (!statSync(f).isDirectory()) throw new Error("not a directory");
    } catch {
      console.error(`Error: ${f} is not a directory`);
      process.exit(1);
    }
  }

  await ingest({ accountId, repoName, folderPaths: folders });
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await closeDb().catch(() => {});
    process.exit(1);
  });
