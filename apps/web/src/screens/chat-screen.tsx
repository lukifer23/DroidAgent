import { ChatScreenShell } from "../components/chat-screen-shell";
import { useChatScreenController } from "../hooks/use-chat-screen-controller";

export function ChatScreen() {
  const controller = useChatScreenController();

  return <ChatScreenShell {...controller} />;
}
