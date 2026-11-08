import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { scanModelConfigs } = await import("../electron/main/importers/model-config.ts");

test("Pi import follows the CLI agent directory from PI_CODING_AGENT_DIR", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-agent-dir-import-"));
  const agentDir = join(home, "cli-agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        shared: {
          name: "Shared CLI provider",
          baseUrl: "https://shared.example/v1",
          api: "openai-completions",
          apiKey: "sk-shared",
          models: [{ id: "shared-model" }],
        },
      },
    }),
  );

  const drafts = await scanModelConfigs({
    homeDir: home,
    env: { PI_CODING_AGENT_DIR: agentDir },
  });
  const shared = drafts.find((draft) => draft.source === "pi" && draft.externalId === "shared");
  assert.ok(shared, "the provider in the CLI agent directory must be imported");
  assert.equal(shared.secretValue, "sk-shared");
});
