// The E2B template work runs in (docs/remote-workspaces.md, "E2B"):
// Node.js 20+, git, curl and the agent CLIs. Optio brings its own CLI and
// runs its start script through the sandbox's envd. Build it with E2B's SDK
// (`npm install e2b`, then `npx tsx template.ts` with E2B_API_KEY set).
import { Template } from "e2b";

const template = Template()
  .fromUbuntuImage("22.04")
  .aptInstall(["ca-certificates", "curl", "git", "sudo"])
  .runCmd(
    "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs",
    {
      user: "root",
    },
  )
  .npmInstall(["@anthropic-ai/claude-code", "opencode-ai"], { g: true });

await Template.build(template, "optio-node", { cpuCount: 2, memoryMB: 2048 });
