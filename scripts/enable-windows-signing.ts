// Injects an Authenticode `signCommand` into the Windows Tauri config so the
// release workflow produces signed installers. Run only from CI, and only when
// the Azure Trusted Signing secrets are present — see docs/windows-release.md.
//
// The command stays out of the committed config on purpose: an unconditional
// signCommand would fail every build without credentials, including forks and
// local `bun run desktop:build`.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG = join(import.meta.dir, "..", "src-tauri", "tauri.windows.conf.json");

const endpoint = process.env.SIGNING_ENDPOINT;
const account = process.env.SIGNING_ACCOUNT;
const profile = process.env.SIGNING_PROFILE;

const missing = Object.entries({ SIGNING_ENDPOINT: endpoint, SIGNING_ACCOUNT: account, SIGNING_PROFILE: profile })
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length > 0) {
  // A partially configured secret set means someone intended to sign and the
  // build would silently ship unsigned installers. Fail loudly instead.
  console.error(`Cannot enable Windows signing, missing: ${missing.join(", ")}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG, "utf8"));
config.bundle ??= {};
config.bundle.windows ??= {};
// trusted-signing-cli reads AZURE_TENANT_ID / AZURE_CLIENT_ID /
// AZURE_CLIENT_SECRET from the environment. %1 is the file Tauri wants signed.
config.bundle.windows.signCommand = `trusted-signing-cli -e ${endpoint} -a ${account} -c ${profile} %1`;

writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Windows signing enabled via ${account}/${profile}`);
