"use client";

import { useEffect, useRef } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import AssistantMessageRow from "./AssistantMessageRow";

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
  currentTool?: string; // 新增：当前执行的工具名
}

export default function ChatList({ messages, isStreaming, currentTool }: ChatListProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const hasInitialScrolled = useRef(false);

  // 自动滚动到底部的逻辑
  useEffect(() => {
    if (messages.length > 0 && virtuosoRef.current) {
      // 首次加载时延迟滚动，确保 DOM 已渲染
      if (!hasInitialScrolled.current) {
        setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({
            index: messages.length - 1,
            align: "end",
            behavior: "auto",
          });
          hasInitialScrolled.current = true;
        }, 100);
      } else {
        // 后续消息更新时平滑滚动
        virtuosoRef.current?.scrollToIndex({
          index: messages.length - 1,
          align: "end",
          behavior: "smooth",
        });
      }
    }
  }, [messages.length]);

  return (
    <div className="min-h-0 flex-1 pb-4">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        alignToBottom
        followOutput={isStreaming ? "smooth" : false}
        itemContent={(index, message) => {
          const isUser = message.role === "user";
          const isLastMessage = index === messages.length - 1; // 判断是否是最后一条消息
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
                        <AssistantMessageRow 
                          content={message.content} 
                          currentTool={isLastMessage ? currentTool : undefined} // 仅对最后一条消息传递 currentTool
                        />
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