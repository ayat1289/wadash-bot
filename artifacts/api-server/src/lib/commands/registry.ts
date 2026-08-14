import type { Command } from "./types";

export const commands = new Map<string, Command>();

export function register(cmds: Command[]): void {
  for (const cmd of cmds) {
    commands.set(cmd.name.toLowerCase(), cmd);
    for (const a of cmd.aliases ?? []) commands.set(a.toLowerCase(), cmd);
  }
}

export function findCommand(name: string): Command | undefined {
  return commands.get(name.toLowerCase());
}
