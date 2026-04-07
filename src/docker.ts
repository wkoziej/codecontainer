import { spawnSync } from "child_process";
import * as net from "net";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { printInfo, printError, printWarning } from "./utils";
import { APPDATA_DIR, DOCKERFILE_PATH, EXTRA_PACKAGES_APT_PATH, APPLE_GIT_INJECT_PATH } from "./paths";
import { loadSettings } from "./config";
import { getAgentMounts, getCommonMounts, loadUserMounts } from "./mounts";
import { loadFlags } from "./flags";
import { CLI_BIN, isAppleContainer, isPodman, runtimeDisplayName } from "./runtime";
import type { ProjectConfig, RestartPolicy } from "./project-config";

export const IMAGE_NAME = "code-container";
export const IMAGE_TAG = "latest";
const PACKAGED_DOCKERFILE = path.resolve(__dirname, "..", "Dockerfile");
const CONTAINER_PREFIX = "container";

export function checkRuntime(): void {
  if (isAppleContainer()) {
    const result = spawnSync(CLI_BIN, ["system", "version"], { stdio: "pipe" });
    if (result.status !== 0) {
      printInfo("Apple Container system not running. Starting...");
      const startResult = spawnSync(CLI_BIN, ["system", "start"], {
        stdio: "inherit",
        timeout: 30000,
      });
      if (startResult.status !== 0) {
        printError(
          "Apple Container is not available. Please install it: https://github.com/apple/container"
        );
        process.exit(1);
      }
    }
  } else {
    const result = spawnSync(CLI_BIN, ["info"], { stdio: "pipe" });
    if (result.status !== 0) {
      printError(
        isPodman()
          ? "Podman is not available. Please install Podman: https://podman.io/docs/installation"
          : "Docker is not available. Please install Docker: https://docs.docker.com/get-docker/"
      );
      process.exit(1);
    }
  }
}

export function getMounts(projectPath: string, projectName: string): string[] {
  const settings = loadSettings();
  const mounts: string[] = [];
  mounts.push(`${projectPath}:/root/${projectName}`);
  mounts.push(...getAgentMounts(settings.agents));
  mounts.push(...getCommonMounts());
  mounts.push(...loadUserMounts());
  return mounts;
}

export function generateContainerName(projectPath: string): string {
  const normalizedPath = projectPath.replace(/\/$/, "");
  const projectName = path.basename(normalizedPath);
  const pathHash = crypto
    .createHash("sha1")
    .update(normalizedPath)
    .digest("hex")
    .substring(0, 8);
  return `${CONTAINER_PREFIX}-${projectName}-${pathHash}`;
}

export function imageExists(imageRef: string = `${IMAGE_NAME}:${IMAGE_TAG}`): boolean {
  const result = spawnSync(
    CLI_BIN,
    ["image", "inspect", imageRef],
    { stdio: "pipe" }
  );
  return result.status === 0;
}

export function ensureDockerfile(): void {
  if (fs.existsSync(PACKAGED_DOCKERFILE)) {
    fs.copyFileSync(PACKAGED_DOCKERFILE, DOCKERFILE_PATH);
  } else if (!fs.existsSync(DOCKERFILE_PATH)) {
    throw new Error(
      `Dockerfile not found at ${DOCKERFILE_PATH} and no packaged Dockerfile available`
    );
  }
  ensureBuildAssets();
}

function ensureBuildAssets(): void {
  // Ensure certs/ directory exists in build context (Dockerfile COPY requires it)
  const certsDir = path.join(APPDATA_DIR, "certs");
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true, mode: 0o755 });
  }

  // Ensure extra_packages.apt exists in build context (Dockerfile COPY requires it)
  if (!fs.existsSync(EXTRA_PACKAGES_APT_PATH)) {
    fs.writeFileSync(
      EXTRA_PACKAGES_APT_PATH,
      "# One apt package per line, e.g.:\n# postgresql-client\n# redis-tools\n"
    );
  }

  // Copy entrypoint scripts to build context (Dockerfile COPY requires them)
  const PACKAGED_SCRIPTS_DIR = path.resolve(__dirname, "..", "scripts");
  for (const script of ["fix-ssh.sh", "codecontainer-entrypoint.sh"]) {
    const src = path.join(PACKAGED_SCRIPTS_DIR, script);
    const dst = path.join(APPDATA_DIR, script);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }
}

export function buildImageRaw(agentIds?: string[], memoryMB?: number, imageRef: string = `${IMAGE_NAME}:${IMAGE_TAG}`): boolean {
  ensureDockerfile();
  const args = ["build", "-t", imageRef];
  if (isAppleContainer()) {
    args.push("-m", `${memoryMB || 4096}MB`);
  }
  if (agentIds) {
    const agentBuildArgMap: Record<string, string> = {
      claude: "INSTALL_CLAUDE",
      opencode: "INSTALL_OPENCODE",
      codex: "INSTALL_CODEX",
      gemini: "INSTALL_GEMINI",
    };
    for (const [id, argName] of Object.entries(agentBuildArgMap)) {
      args.push("--build-arg", `${argName}=${agentIds.includes(id) ? "1" : "0"}`);
    }
  }
  args.push(APPDATA_DIR);
  const result = spawnSync(CLI_BIN, args, { stdio: "inherit" });
  return result.status === 0;
}

export function pushImageRaw(imageRef: string): boolean {
  const result = spawnSync(CLI_BIN, ["push", imageRef], { stdio: "inherit" });
  return result.status === 0;
}

export function containerExists(containerName: string): boolean {
  if (isAppleContainer()) {
    const result = spawnSync(CLI_BIN, ["inspect", containerName], {
      stdio: "pipe",
    });
    if (result.status !== 0) return false;
    // Apple container CLI returns exit 0 with empty "[]" for non-existent containers
    try {
      const data = JSON.parse(result.stdout.toString());
      return Array.isArray(data) ? data.length > 0 : !!data;
    } catch {
      return false;
    }
  }
  const result = spawnSync(CLI_BIN, ["container", "inspect", containerName], {
    stdio: "pipe",
  });
  return result.status === 0;
}

export function containerRunning(containerName: string): boolean {
  if (isAppleContainer()) {
    const result = spawnSync(
      CLI_BIN,
      ["inspect", "--format", "json", containerName],
      { stdio: "pipe" }
    );
    if (result.status !== 0) return false;
    try {
      const data = JSON.parse(result.stdout.toString());
      const status = Array.isArray(data) ? data[0]?.State?.Status : data?.State?.Status;
      return status === "running";
    } catch {
      return false;
    }
  }
  const result = spawnSync(
    CLI_BIN,
    ["container", "inspect", "-f", "{{.State.Running}}", containerName],
    { stdio: "pipe" }
  );
  return result.status === 0 && result.stdout.toString().trim() === "true";
}

export function stopContainer(containerName: string): void {
  // Reset restart policy before stopping so Docker doesn't restart the container
  if (!isAppleContainer()) {
    spawnSync(CLI_BIN, ["update", "--restart", "no", containerName], { stdio: "pipe" });
  }

  if (isAppleContainer()) {
    spawnSync(CLI_BIN, ["stop", "--time", "3", containerName], { stdio: "inherit" });
  } else if (isPodman()) {
    spawnSync(CLI_BIN, ["stop", "--time", "3", containerName], { stdio: "inherit" });
  } else {
    spawnSync(CLI_BIN, ["stop", "--timeout", "3", containerName], { stdio: "inherit" });
  }
}

export function startContainer(containerName: string, restartPolicy?: RestartPolicy): void {
  spawnSync(CLI_BIN, ["start", containerName], { stdio: "inherit" });

  // Restore restart policy after start (stopContainer resets it to "no")
  if (restartPolicy && !isAppleContainer()) {
    spawnSync(CLI_BIN, ["update", "--restart", restartPolicy, containerName], { stdio: "pipe" });
  }
}

export function removeContainer(containerName: string): void {
  if (isAppleContainer()) {
    spawnSync(CLI_BIN, ["delete", containerName], { stdio: "inherit" });
  } else {
    spawnSync(CLI_BIN, ["rm", containerName], { stdio: "inherit" });
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

export async function findAvailablePort(preferred: number, range: number = 100): Promise<number | null> {
  for (let port = preferred; port < preferred + range; port++) {
    if (await isPortAvailable(port)) return port;
  }
  return null;
}

export interface ContainerCreateOptions {
  cmd?: string;
  restart?: RestartPolicy;
}

export async function createNewContainer(
  containerName: string,
  projectName: string,
  projectPath: string,
  projectConfig?: ProjectConfig | null,
  headlessOptions?: ContainerCreateOptions
): Promise<boolean> {
  const mounts = getMounts(projectPath, projectName);
  const settings = loadSettings();
  const args = ["run", "-d", "--name", containerName];

  if (isAppleContainer()) {
    args.push("-m", `${settings.memoryMB || 4096}MB`);
  }

  args.push("-e", "TERM=xterm-256color");

  // Port mapping: use forwardPorts from project config, or default to auto-find port 3000
  if (projectConfig?.forwardPorts && projectConfig.forwardPorts.length > 0) {
    for (const containerPort of projectConfig.forwardPorts) {
      const hostPort = await findAvailablePort(containerPort);
      if (hostPort) {
        args.push("-p", `${hostPort}:${containerPort}`);
        if (hostPort !== containerPort) {
          printWarning(`Port ${containerPort} in use, mapping to host port ${hostPort}`);
        }
      } else {
        printWarning(`No available port found for ${containerPort}, skipping`);
      }
    }
  } else {
    const port = await findAvailablePort(3000);
    if (port) {
      args.push("-p", `${port}:3000`);
      if (port !== 3000) {
        printWarning(`Port 3000 in use, mapping container port 3000 to host port ${port}`);
      }
    } else {
      printWarning("No available port found in range 3000-3099, skipping port mapping");
    }
  }

  // Container environment variables from project config
  if (projectConfig?.containerEnv) {
    for (const [key, value] of Object.entries(projectConfig.containerEnv)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  // Hostname from project config name
  if (projectConfig?.name) {
    args.push("--hostname", projectConfig.name);
  }

  args.push("-w", `/root/${projectName}`);

  for (const mount of mounts) {
    args.push("-v", mount);
  }

  // Project-specific mounts (additive)
  if (projectConfig?.mounts) {
    for (const mount of projectConfig.mounts) {
      args.push("-v", mount);
    }
  }

  if (!isAppleContainer()) {
    const flags = loadFlags();
    args.push(...flags);

    // Project-specific runArgs (Docker/Podman only)
    if (projectConfig?.runArgs) {
      args.push(...projectConfig.runArgs);
    }
  } else if (projectConfig?.runArgs && projectConfig.runArgs.length > 0) {
    printWarning("runArgs are not supported on Apple Container, skipping");
  }

  // Secrets as read-only volume mounts
  const secrets = projectConfig?.secrets;
  if (secrets && secrets.length > 0) {
    if (isAppleContainer()) {
      printWarning("secrets are not supported on Apple Container, skipping");
    } else {
      for (const secret of secrets) {
        if (!fs.existsSync(secret.file)) {
          printError(`Secret file not found: ${secret.file}`);
          process.exit(1);
        }
        if (!fs.statSync(secret.file).isFile()) {
          printError(`Secret path is not a file: ${secret.file}`);
          process.exit(1);
        }
        args.push("-v", `${secret.file}:/run/secrets/${secret.name}:ro`);
      }
    }
  }

  // Restart policy (Docker/Podman only)
  const restart = headlessOptions?.restart ?? projectConfig?.restart;
  if (restart) {
    if (isAppleContainer()) {
      printWarning("restart policy is not supported on Apple Container, skipping");
    } else {
      args.push("--restart", restart);
    }
  }

  // Store config hash as label for drift detection
  const { hashProjectConfigFile } = await import("./project-config");
  const configHash = hashProjectConfigFile(projectPath);
  if (configHash && !isAppleContainer()) {
    args.push("--label", `codecontainer.config-hash=${configHash}`);
  }

  // CMD: headless cmd overrides default sleep infinity
  const cmd = headlessOptions?.cmd ?? projectConfig?.cmd;
  if (cmd) {
    args.push(`${IMAGE_NAME}:${IMAGE_TAG}`, "bash", "-c", cmd);
  } else {
    args.push(`${IMAGE_NAME}:${IMAGE_TAG}`, "sleep", "infinity");
  }

  const result = spawnSync(CLI_BIN, args, { stdio: "inherit" });
  return result.status === 0;
}

export function getContainerLabel(containerName: string, label: string): string | null {
  const result = spawnSync(CLI_BIN, [
    "inspect", "--format", `{{index .Config.Labels "${label}"}}`, containerName
  ], { stdio: "pipe" });

  if (result.status !== 0) return null;
  const value = result.stdout?.toString().trim();
  if (!value || value === "<no value>") return null;
  return value;
}

export function execInContainer(containerName: string, command: string[]): boolean {
  const result = spawnSync(CLI_BIN, ["exec", containerName, ...command], { stdio: "inherit" });
  return result.status === 0;
}

export function execInteractive(
  containerName: string,
  projectName: string
): void {
  const args = [
    "exec",
    "-it",
    "-e",
    "TERM=xterm-256color",
  ];

  // Apple Container doesn't inherit ENV PATH from Dockerfile in exec sessions
  if (isAppleContainer()) {
    args.push("-e", "PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    args.push("-e", "NVM_DIR=/root/.nvm");
    args.push("-e", `GIT_CONFIG_GLOBAL=${APPLE_GIT_INJECT_PATH}/.gitconfig`);
  }

  args.push("-w", `/root/${projectName}`, containerName,
    "/bin/bash");

  spawnSync(CLI_BIN, args, { stdio: "inherit" });
}

export function getOtherSessionCount(
  containerName: string,
  projectName: string
): number {
  const result = spawnSync("ps", ["ax", "-o", "command="], {
    encoding: "utf-8",
  });
  if (result.status !== 0) return 0;

  const execCmd = `${CLI_BIN} exec`;
  const lines = result.stdout.split("\n");
  let count = 0;

  for (const line of lines) {
    const hasExec = line.includes(execCmd);
    const hasIt = line.includes("-it");
    const hasContainerName = line.includes(containerName);
    const hasBash = line.includes("/bin/bash");
    const hasWorkdir = line.includes(`-w /root/${projectName}`);

    if (hasExec && hasIt && hasContainerName && hasBash && hasWorkdir) {
      count++;
    }
  }

  return count;
}

export function stopContainerIfLastSession(
  containerName: string,
  projectName: string
): void {
  const otherSessions = getOtherSessionCount(containerName, projectName);
  if (otherSessions === 0) {
    stopContainer(containerName);
  } else {
    printInfo(
      `Skipping stop; ${otherSessions} other terminal(s) still attached`
    );
  }
}

export function listContainersRaw(): void {
  if (isAppleContainer()) {
    const result = spawnSync(CLI_BIN, ["list", "--format", "json"], {
      encoding: "utf8",
    });
    if (result.status !== 0 || !result.stdout.trim()) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const containers: any[] = JSON.parse(result.stdout);
      const filtered = (Array.isArray(containers) ? containers : []).filter(
        (c) => {
          const name = c.configuration?.id || c.Name || c.Names || "";
          return name.startsWith(`${CONTAINER_PREFIX}-`);
        }
      );
      if (filtered.length === 0) return;
      console.log("NAMES\tSTATUS\tCREATED");
      for (const c of filtered) {
        const name = c.configuration?.id || c.Name || c.Names || "";
        const status = c.status || c.Status || c.State || "";
        const created = c.startedDate
          ? new Date(c.startedDate * 1000).toISOString()
          : c.CreatedAt || c.Created || "";
        console.log(`${name}\t${status}\t${created}`);
      }
    } catch {
      spawnSync(CLI_BIN, ["list"], { stdio: "inherit" });
    }
  } else {
    spawnSync(
      CLI_BIN,
      [
        "ps",
        "-a",
        "--filter",
        `name=${CONTAINER_PREFIX}-`,
        "--format",
        "table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}",
      ],
      { stdio: "inherit" }
    );
  }
}

export function getStoppedContainerIds(): string[] {
  if (isAppleContainer()) {
    const result = spawnSync(CLI_BIN, ["list", "--format", "json"], {
      encoding: "utf8",
    });
    if (result.status !== 0 || !result.stdout.trim()) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const containers: any[] = JSON.parse(result.stdout);
      return (Array.isArray(containers) ? containers : [])
        .filter((c) => {
          const name = c.configuration?.id || c.Name || c.Names || "";
          const status = (c.status || c.Status || c.State || "").toLowerCase();
          return (
            name.startsWith(`${CONTAINER_PREFIX}-`) &&
            (status === "exited" || status === "stopped")
          );
        })
        .map((c) => c.configuration?.id || c.Id || c.ID || c.Name || c.Names || "");
    } catch {
      return [];
    }
  }

  const result = spawnSync(
    CLI_BIN,
    [
      "ps",
      "-a",
      "--filter",
      `name=${CONTAINER_PREFIX}-`,
      "--filter",
      "status=exited",
      "--quiet",
    ],
    { encoding: "utf8" }
  );

  const containerIds = result.stdout.trim();
  if (!containerIds) return [];

  return containerIds.split("\n");
}


export function removeContainersById(ids: string[]): void {
  if (isAppleContainer()) {
    spawnSync(CLI_BIN, ["delete", ...ids], { stdio: "inherit" });
  } else {
    spawnSync(CLI_BIN, ["rm", ...ids], { stdio: "inherit" });
  }
}
