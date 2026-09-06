import { MessageSquareText } from "lucide-react";

/** Text-bearing chat glyph on a light chip so it stays visible across the dark UI. */
export function ChatMark() {
  return (
    <span aria-hidden className="chat-mark">
      <MessageSquareText color="#0b0b0c" size={12} strokeWidth={2.5} />
    </span>
  );
}
