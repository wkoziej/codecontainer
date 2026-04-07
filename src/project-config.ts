import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { z } from "zod";
import { parse } from "shell-quote";
import { printWarning, printInfo, promptYesNo } from "./utils";
import { loadSettings, saveSettings } from "./config";

const CONFIG_FILENAME = ".codecontainer.json";

export const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  forwardPorts: z.array(z.number().int().positive()).optional(),
  containerEnv: z.record(z.string(), z.string()).optional(),
  packages: z.array(z.string()).optional(),
  mounts: z.array(z.string()).optional(),
  runArgs: z.array(z.string()).optional(),
  postCreateCommand: z.string().optional(),
  secrets: z.array(z.object({
    name: z.string()
      .regex(/^[a-zA-Z0-9_-]+$/, "secret name: only alphanumeric, dash, underscore"),
    file: z.string()
      .refine(f => !f.includes('..'), "secret file: path traversal not allowed"),
  })).optional(),
  cmd: z.string().optional(),
  restart: z.enum(["no", "on-failure", "unless-stopped", "always"]).optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const VALID_RESTART_POLICIES = ["no", "on-failure", "unless-stopped", "always"] as const;
export type RestartPolicy = typeof VALID_RESTART_POLICIES[number];

export function loadProjectConfig(projectPath: string): ProjectConfig | null {
  const configPath = path.join(projectPath, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    printWarning(`Failed to read ${CONFIG_FILENAME}: ${err}`);
    return null;
  }

  if (!raw.trim()) {
    printWarning(`${CONFIG_FILENAME} is empty, ignoring`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    printWarning(`Invalid JSON in ${CONFIG_FILENAME}: ${err}`);
    return null;
  }

  const result = ProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    printWarning(`Invalid ${CONFIG_FILENAME}:\n${issues}`);
    return null;
  }

  // Validate runArgs entries don't contain shell operators
  if (result.data.runArgs) {
    for (const arg of result.data.runArgs) {
      const tokens = parse(arg);
      const hasOperator = tokens.some(t => typeof t !== "string");
      if (hasOperator) {
        printWarning(`Rejected runArgs entry with shell operator: "${arg}"`);
        return null;
      }
    }
  }

  return result.data;
}

export function hashProjectConfigFile(projectPath: string): string | null {
  const configPath = path.join(projectPath, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath);
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

const SECURITY_SENSITIVE_FIELDS: (keyof ProjectConfig)[] = [
  "runArgs",
  "packages",
  "postCreateCommand",
  "mounts",
  "containerEnv",
  "secrets",
  "cmd",
];

export function hasSecuritySensitiveFields(config: ProjectConfig): boolean {
  return SECURITY_SENSITIVE_FIELDS.some(field => {
    const value = config[field];
    if (value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });
}

function projectPathHash(projectPath: string): string {
  return crypto.createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

export async function confirmProjectConfig(
  config: ProjectConfig,
  projectPath: string
): Promise<ProjectConfig> {
  if (!hasSecuritySensitiveFields(config)) {
    return config;
  }

  const configHash = hashProjectConfigFile(projectPath);
  if (!configHash) {
    return config;
  }

  const pathKey = projectPathHash(projectPath);
  const settings = loadSettings();
  const accepted = settings.acceptedProjectConfigs ?? {};

  if (accepted[pathKey] === configHash) {
    return config;
  }

  // Show security-sensitive fields to user
  printInfo("");
  printWarning("The project's .codecontainer.json contains security-sensitive fields:");
  printWarning("These fields execute as root or expose host resources.");
  printInfo("");

  if (config.runArgs && config.runArgs.length > 0) {
    printInfo(`  runArgs: ${JSON.stringify(config.runArgs)}`);
  }
  if (config.packages && config.packages.length > 0) {
    printInfo(`  packages: ${JSON.stringify(config.packages)}`);
  }
  if (config.postCreateCommand) {
    printInfo(`  postCreateCommand: "${config.postCreateCommand}"`);
  }
  if (config.mounts && config.mounts.length > 0) {
    printInfo(`  mounts: ${JSON.stringify(config.mounts)}`);
  }
  if (config.containerEnv && Object.keys(config.containerEnv).length > 0) {
    printInfo(`  containerEnv: ${JSON.stringify(config.containerEnv)}`);
  }
  if (config.secrets && config.secrets.length > 0) {
    printInfo(`  secrets: ${JSON.stringify(config.secrets)}`);
  }
  if (config.cmd) {
    printInfo(`  cmd: "${config.cmd}"`);
  }
  printInfo("");

  const confirmed = await promptYesNo("Apply these settings from .codecontainer.json?");

  if (confirmed) {
    settings.acceptedProjectConfigs = { ...accepted, [pathKey]: configHash };
    saveSettings(settings);
    return config;
  }

  // Strip security-sensitive fields, keep only name and forwardPorts
  printWarning("Security-sensitive fields rejected. Applying only name and forwardPorts.");
  return {
    name: config.name,
    forwardPorts: config.forwardPorts,
  };
}
