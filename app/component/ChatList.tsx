"use client";

import { useEffect, useRef } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import AssistantMessageRow from "./AssistantMessageRow";
import { ToolNameMap } from "../const/pageConst";

// 1. 扩展 Message 类型，增加 tool_calls 字段
type ToolCall = {
  id: string;
  name: string;
  args: any;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  tool_calls?: ToolCall[]; // 新增字段
};

interface ChatListProps {
  messages: Message[];
  isStreaming: boolean;
}

export default function ChatList({ messages, isStreaming }: ChatListProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const hasInitialScrolled = useRef(false);

  // ... (保持你原有的 useEffect 滚动逻辑不变) ...

  return (
    <div className="min-h-0 flex-1 pb-4">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        alignToBottom
        // ... (保持 followOutput 不变) ...
        itemContent={(index, message) => {
          const isUser = message.role === "user";
          return (
            <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
              <div className={`max-w-[85%] rounded-lg px-4 py-3 text-sm shadow-sm ${
                isUser ? "bg-blue-600 text-white" : "bg-white border border-zinc-100"
              }`}>
                {/* 如果是用户消息 */}
                {isUser && <div>{message.content}</div>}

                {/* 如果是 AI 消息 */}
                {!isUser && (
                  <>
                    {/* B. 渲染常规回复 */}
                    {message.content && (
                      <div className="whitespace-pre-wrap">
                        <AssistantMessageRow content={message.content} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}