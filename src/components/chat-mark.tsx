import { MessageCircle } from "lucide-react";

/** Solid black chat glyph on a light chip so it stays visible across the dark UI. */
export function ChatMark() {
  return (
    <span aria-hidden className="chat-mark">
      <MessageCircle color="#0b0b0c" fill="#0b0b0c" size={11} />
    </span>
  );
}
