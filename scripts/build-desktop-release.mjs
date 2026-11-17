import { spawn } from "node:child_process";
import process from "node:process";
import {
  channelAppId,
  channelArtifactPrefix,
  channelProductName,
  resolveBuildChannel,
} from "../apps/desktop/src/lib/build-channel.ts";

const forwardedArgs = process.argv.slice(2);

const hostTarget =
  process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : "linux";
const requestedTarget = ["linux", "mac", "win"].includes(forwardedArgs[0])
  ? forwardedArgs.shift()
  : undefined;
const target = requestedTarget ?? hostTarget;

if (!["linux", "mac", "win"].includes(target)) {
  throw new Error(`Unsupported desktop release target: ${target}`);
}

/**
 * The channel comes from the build command, never from the version string
 * (ADR dev-channel-parallel-installation): `--channel dev` gives the build its
 * own appId, product name, artifact prefix, and `piChannel` marker, so a Dev
 * install can sit next to stable without sharing userData or shortcuts.
 */
const channelArgIndex = forwardedArgs.findIndex(
  (arg) => arg === "--channel" || arg.startsWith("--channel="),
);
let channelArg;
if (channelArgIndex >= 0) {
  const [flag] = forwardedArgs.splice(channelArgIndex, 1);
  channelArg = flag === "--channel" ? forwardedArgs.splice(channelArgIndex, 1)[0] : flag.split("=")[1];
}
const channel = resolveBuildChannel({ piChannel: channelArg });
if (channelArg !== undefined && channel !== "dev" && channelArg !== "stable") {
  throw new Error(`Unsupported desktop release channel: ${channelArg}`);
}

const artifactPrefix = channelArtifactPrefix(channel);

/** Identity flags shared by every target and distribution of this channel. */
const channelFlags = [
  `-c.appId=${channelAppId(channel)}`,
  `-c.productName=${channelProductName(channel)}`,
  `-c.extraMetadata.piChannel=${channel}`,
  // Artifact names stay explicit per target: productName is baked into some
  // templates, and a Dev build must never produce a stable-looking filename.
  `-c.mac.artifactName=${artifactPrefix}-\${version}-\${arch}-mac.\${ext}`,
  `-c.linux.artifactName=${artifactPrefix}-\${version}-linux-\${arch}.\${ext}`,
  `-c.win.artifactName=${artifactPrefix}-Portable-\${version}.\${ext}`,
  `-c.nsis.artifactName=${artifactPrefix}-Setup-\${version}.\${ext}`,
  `-c.portable.artifactName=${artifactPrefix}-Portable-\${version}.\${ext}`,
];

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/**
 * `--dry-run` prints the electron-builder invocations instead of running them.
 * It exists so the channel plumbing can be verified without a full package
 * build (tests assert the flags a Dev build would receive).
 */
const dryRun = forwardedArgs.includes("--dry-run");
if (dryRun) forwardedArgs.splice(forwardedArgs.indexOf("--dry-run"), 1);

function runBuilder(args) {
  if (dryRun) {
    console.log(JSON.stringify(["electron-builder", ...args]));
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmCommand, ["exec", "electron-builder", ...args], {
      // Windows exposes pnpm as a .cmd shim. Launch it through the shell so
      // Node can start the shim consistently on the hosted Windows runner.
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `electron-builder ${target} target failed with ${
            code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`
          }`,
        ),
      );
    });
  });
}

if (target === "win") {
  await runBuilder([
    "--win",
    "nsis",
    "--publish",
    "never",
    ...forwardedArgs,
    ...channelFlags,
    "-c.extraMetadata.piDistribution=installed",
  ]);
  await runBuilder([
    "--win",
    "zip",
    "--publish",
    "never",
    ...forwardedArgs,
    ...channelFlags,
    "-c.extraMetadata.piDistribution=zip",
  ]);
  await runBuilder([
    "--win",
    "portable",
    "--publish",
    "never",
    ...forwardedArgs,
    ...channelFlags,
    "-c.extraMetadata.piDistribution=portable",
  ]);
} else {
  await runBuilder([
    `--${target}`,
    "--publish",
    "never",
    ...forwardedArgs,
    ...channelFlags,
  ]);
}

console.log(`Packaged the ${channel} channel as ${channelProductName(channel)}.`);
