import type { Metadata } from "next";
import { ChatClient } from "./ChatClient";
import "./chat.css";

export const metadata: Metadata = {
  title: "S’mile · Private iMessage",
  description: "Connect a private Photon iMessage line and message @smile for trip planning and travel-buddy matching.",
};

export default function Chat() {
  return <ChatClient />;
}
