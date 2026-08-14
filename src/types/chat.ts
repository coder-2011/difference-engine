// Keep client and server validation aligned on one chat request contract.
export const MAX_CHAT_HISTORY_TURNS = 6;
export const MAX_CHAT_ATTACHMENTS = 4;
export const MAX_CHAT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 16 * 1024 * 1024;

export type ChatTurn = {
  answer: string;
  attachments?: string[];
  question: string;
  selection: string;
};
