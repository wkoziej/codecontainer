#!/usr/bin/env node

import { printError, printInfo, promptYesNo, resolveProjectPath } from "./utils";
import {
  buildImage,
  buildK8sImage,
  runContainer,
  runK8sContainer,
  loginK8s,
  remoteK8s,
  stopContainerForProject,
  stopK8sContainerForProject,
  removeContainerForProject,
  listContainers,
  listK8sContainers,
  cleanContainers,
  syncConfigs,
  init,
  removeK8sContainerForProject,
  type RunContainerOptions,
} from "./commands";
import { checkRuntime } from "./docker";
import { loadSettings, saveSettings } from "./config";
import { ensureMountsFile } from "./mounts";
import type { K8sOverrides } from "./k8s";
import { VALID_RESTART_POLICIES, type RestartPolicy } from "./project-config";

const TOS = `
\x1b[33m⚠️  Security Advisory:\x1b[0m

The main purpose of Code Container is to protect commands like 'rm' or 'apt'
from unintentionally affecting your main system.

codecontainer does not protect from prompt injections in the event that an agent
becomes malaligned.

This is an innate problem within coding harness software and codecontainer does
not attempt to solve it.

Users are advised to not download or work with unverified software.
- Sensitive information inside the container may still be exfiltrated by
  an attacker just as with your regular system.
  - This includes:
  - OAuth credentials inside harness configs
  - API keys inside harness configs
  - SSH keys for git functionality if enabled

Never install or run your harness on unverified software. By using Code
Container, you agree that you are aware of these risks and will not hold the
author liable for any outcomes arising from usage of the software.
`;

async function ensureTosAccepted(): Promise<boolean> {
  const settings = loadSettings();
  if (settings.acceptedTos) {
    return true;
  }

  console.log(TOS);
  const accepted = await promptYesNo("Do you accept these terms?");
  if (accepted) {
    settings.acceptedTos = true;
    saveSettings(settings);
    return true;
  }
  return false;
}

function usage(): void {
  console.log(`
Usage: codecontainer [COMMAND] [PROJECT_PATH]

Manage Code containers for isolated project environments.

Commands:
    (none)         Start container for current directory (default)
    run            Start container for specified project path
    build          Build the container image
    login          Run Claude login flow inside a Kubernetes pod
    remote         Start Claude Remote Control inside a Kubernetes pod
    init           Select agents, copy config files, and configure permissions
    sync           Re-sync config files from host to container configs
    stop           Stop the container for this project
    remove         Remove the container for this project
    list           List all Code containers
    clean          Remove all stopped Code containers

Arguments:
    PROJECT_PATH    Path to the project directory (defaults to current directory)

Flags:
    --headless            Run container in background (no interactive shell)
    --cmd "COMMAND"       Override container CMD (implies --headless)
    --restart POLICY      Docker restart policy (no|on-failure|unless-stopped|always)
    --k8s                 Use the experimental Kubernetes backend
    --namespace NAME      Override configured Kubernetes namespace
    --context NAME        Override kubectl context
    --registry REF        Override Kubernetes image registry
    --workspace-size SIZE Override Kubernetes PVC size
    --cpu VALUE           Override Kubernetes CPU request/limit
    --memory VALUE        Override Kubernetes memory request/limit
    --name VALUE          Session name for \`remote --k8s\`

Examples:
    codecontainer                           # Start container for current directory
    codecontainer run /path/to/project      # Start container for specific project
    codecontainer run --cmd "bash runner.sh" # Run container in headless mode
    codecontainer run --headless            # Start headless (uses cmd from .codecontainer.json)
    codecontainer run --restart unless-stopped  # Set restart policy
    codecontainer build                     # Build container image
    codecontainer build --k8s               # Build Kubernetes image
    codecontainer login --k8s               # Log Claude into the Kubernetes pod
    codecontainer remote --k8s              # Start Claude Remote Control in Kubernetes
    codecontainer init                      # Configure agents and permissions
    codecontainer sync                      # Re-sync config files from host
    codecontainer stop                      # Stop container for current directory
    codecontainer remove /path/to/project   # Remove container for specific project
    codecontainer list                      # List all containers
    codecontainer clean                     # Clean up stopped containers
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let command = "";
  let projectPath = "";
  const options: K8sOverrides & { k8s?: boolean } & RunContainerOptions = {};
  const validCommands = [
    "run",
    "build",
    "login",
    "remote",
    "init",
    "sync",
    "stop",
    "remove",
    "list",
    "clean",
  ];

  if (args.length > 0) {
    const firstArg = args[0];
    if (firstArg === "help" || firstArg === "--help" || firstArg === "-h") {
      usage();
    }

    if (validCommands.includes(firstArg)) {
      command = firstArg;
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
          case "--headless":
            options.headless = true;
            break;
          case "--cmd":
            options.cmd = args[++i];
            break;
          case "--restart": {
            const restartVal = args[++i];
            if (!restartVal || !VALID_RESTART_POLICIES.includes(restartVal as RestartPolicy)) {
              printError(`Invalid restart policy: "${restartVal}". Valid: ${VALID_RESTART_POLICIES.join(", ")}`);
              process.exit(1);
            }
            options.restart = restartVal as RestartPolicy;
            break;
          }
          case "--k8s":
            options.k8s = true;
            break;
          case "--namespace":
            options.namespace = args[++i];
            break;
          case "--context":
            options.context = args[++i];
            break;
          case "--registry":
            options.registry = args[++i];
            break;
          case "--workspace-size":
            options.workspaceSize = args[++i];
            break;
          case "--cpu":
            options.cpu = args[++i];
            break;
          case "--memory":
            options.memory = args[++i];
            break;
          case "--name":
            options.remoteName = args[++i];
            break;
          default:
            if (arg.startsWith("--")) {
              printError(`Unknown flag: ${arg}`);
              usage();
            }
            if (!projectPath) {
              projectPath = arg;
              break;
            }
            printError(`Unexpected argument: ${arg}`);
            usage();
        }
      }
    } else if (firstArg.startsWith("--")) {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
          case "--headless":
            options.headless = true;
            break;
          case "--cmd":
            options.cmd = args[++i];
            break;
          case "--restart": {
            const restartVal = args[++i];
            if (!restartVal || !VALID_RESTART_POLICIES.includes(restartVal as RestartPolicy)) {
              printError(`Invalid restart policy: "${restartVal}". Valid: ${VALID_RESTART_POLICIES.join(", ")}`);
              process.exit(1);
            }
            options.restart = restartVal as RestartPolicy;
            break;
          }
          case "--k8s":
            options.k8s = true;
            break;
          case "--namespace":
            options.namespace = args[++i];
            break;
          case "--context":
            options.context = args[++i];
            break;
          case "--registry":
            options.registry = args[++i];
            break;
          case "--workspace-size":
            options.workspaceSize = args[++i];
            break;
          case "--cpu":
            options.cpu = args[++i];
            break;
          case "--memory":
            options.memory = args[++i];
            break;
          case "--name":
            options.remoteName = args[++i];
            break;
          default:
            printError(`Unknown flag: ${arg}`);
            usage();
        }
      }
    } else {
      printError(`Unknown command: ${firstArg}`);
      usage();
    }
  }

  if (!await ensureTosAccepted()) {
    printInfo("Terms not accepted. Exiting...");
    process.exit(1);
  }

  await ensureMountsFile();

  if (command === "init") {
    await init();
    return;
  }

  if (command === "sync") {
    syncConfigs();
    return;
  }

  await init(true);
  const resolvedPath = resolveProjectPath(projectPath);

  if (!options.k8s) {
    checkRuntime();
  }

  switch (command) {
    case "list":
      if (options.k8s) {
        listK8sContainers(options);
      } else {
        listContainers();
      }
      return;
    case "clean":
      if (options.k8s) {
        printError("The clean command currently supports only local containers.");
        process.exit(1);
      }
      cleanContainers();
      return;
    case "build":
      if (options.k8s) {
        await buildK8sImage(options);
      } else {
        await buildImage();
      }
      return;
    case "login":
      if (!options.k8s) {
        printError("The login command currently supports only --k8s.");
        process.exit(1);
      }
      loginK8s(resolvedPath, options);
      return;
    case "remote":
      if (!options.k8s) {
        printError("The remote command currently supports only --k8s.");
        process.exit(1);
      }
      remoteK8s(resolvedPath, options);
      return;
    case "stop":
      if (options.k8s) {
        stopK8sContainerForProject(resolvedPath, options);
      } else {
        stopContainerForProject(resolvedPath);
      }
      return;
    case "remove":
      if (options.k8s) {
        removeK8sContainerForProject(resolvedPath, options);
      } else {
        removeContainerForProject(resolvedPath);
      }
      return;
    case "run":
    case "":
      if (options.k8s) {
        await runK8sContainer(resolvedPath, options);
      } else {
        await runContainer(resolvedPath, options);
      }
      return;
  }
}

main();
