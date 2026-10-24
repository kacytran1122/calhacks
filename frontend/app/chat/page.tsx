import type { Metadata } from "next";
import { ChatClient } from "./ChatClient";
import "./chat.css";

export const metadata: Metadata = { title: "S’mile · @smile group chat" };

export default function Chat() {
  return <ChatClient />;
}
