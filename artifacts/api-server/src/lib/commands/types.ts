import type { WASocket, GroupMetadata, WAMessage } from "@whiskeysockets/baileys";
import type { BotConfigData } from "../config";

export type { WAMessage };

export interface CommandContext {
  sock: WASocket;
  /** The tenant whose WhatsApp connection received this message. */
  tenantId: number;
  msg: WAMessage;
  from: string;
  sender: string;
  senderNumber: string;
  pushName: string;
  isGroup: boolean;
  command: string;
  prefix: string;
  args: string[];
  text: string;
  body: string;
  config: BotConfigData;
  isOwner: boolean;
  /** True when the sender is a sudo user (allowed to use the bot while private). */
  isSudo: boolean;
  groupMetadata: GroupMetadata | null;
  isAdmin: boolean;
  isBotAdmin: boolean;
  quotedText: string | null;
  reply: (text: string) => Promise<void>;
  react: (emoji: string) => Promise<void>;
}

export interface Command {
  name: string;
  aliases?: string[];
  category: string;
  desc?: string;
  ownerOnly?: boolean;
  adminOnly?: boolean;
  botAdminOnly?: boolean;
  groupOnly?: boolean;
  handler: (ctx: CommandContext) => Promise<void>;
}
