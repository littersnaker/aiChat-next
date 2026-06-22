import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { NextResponse } from "next/server";
import { graph } from "./agent/graph";
import { ToolNameMap } from "@/app/const/pageConst";

const QWEN_STREAM_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

interface FrontendMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface StreamDeltaResponse {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

interface AgentStateValues extends Record<string, unknown> {
  messages?: BaseMessage[];
  summary?: string;
}

interface ToolPayload extends Record<string, unknown> {
  pendingDiffResult?: string;
}

// ====================================================
// 🛡️ 核心修复：高级 XML 流碎片过滤器
// 专门解决流式输出时 `<func` 和 `tion_calls>` 被切断导致的泄露问题
// ====================================================
class XMLStreamFilter {
  private buffer = "";

  public process(chunk: string): string {
    this.buffer += chunk;

    // 核心改进：无论模型输出了什么奇怪的 XML 标签碎片，
    // 如果它包含 "<" 但还没有拼成一个完整的标签，我们先缓存；
    // 如果它看起来像是一个完整的 XML 标签，直接整体干掉！

    // 1. 尝试匹配所有可能的 XML 标签 (包含 <function_calls>, <think> 等)
    // 注意：如果我们想保留 <think> 标签，这里要排除它
    const xmlTagRegex = /<[^>]+>|<\/[^>]+>/g;

    // 2. 将缓冲区中所有匹配到的 XML 标签替换为空
    // 我们只处理已经完整出现的标签，半截的先留在 buffer 里
    const output = this.buffer.replace(xmlTagRegex, (match) => {
      // 只要不是我们想要保留的 <think> 和 </think>，全部过滤掉
      if (match.includes("<think") || match.includes("</think")) {
        return match;
      }
      return "";
    });

    // 3. 简单的碎片保护：如果缓冲区末尾以 "<" 开头，说明可能有一个标签在切断中
    // 我们把剩余部分留给下一个 chunk 处理，防止截断导致显示乱码
    if (this.buffer.includes("<") && !this.buffer.endsWith(">")) {
      const lastBracket = this.buffer.lastIndexOf("<");
      const completePart = this.buffer.slice(0, lastBracket);
      this.buffer = this.buffer.slice(lastBracket); // 留下半截
      return completePart.replace(xmlTagRegex, "");
    }

    this.buffer = ""; // 缓冲区清空
    return output;
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!process.env.DASHSCOPE_API_KEY) {
    return NextResponse.json(
      { error: "Missing DASHSCOPE_API_KEY" },
      { status: 500 },
    );
  }

  try {
    const body = (await req.json()) as {
      messages?: FrontendMessage[];
      sessionId?: string;
    };
    const messages = body.messages || [];
    const sessionId = body.sessionId || "default-global-thread";

    const inputMessages: BaseMessage[] = messages.map((m) => {
      if (m.role === "user") return new HumanMessage(m.content);
      if (m.role === "assistant") return new AIMessage(m.content);
      return new SystemMessage(m.content);
    });

    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8");

    const outputStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));

        const totalGraphStart = performance.now();
        let lastNodeTimestamp = performance.now();

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "STATUS", content: "🤖 Agent 收到指令，开始激活工作流拓扑网..." })}\n\n`,
          ),
        );

        let finalState: AgentStateValues | null = null;

        try {
          const graphStream = await graph.stream(
            { messages: inputMessages },
            {
              configurable: { thread_id: sessionId },
              recursionLimit: 50,
              streamMode: "updates",
            },
          );

          for await (const chunk of graphStream) {
            const now = performance.now();
            const nodeElapsed = ((now - lastNodeTimestamp) / 1000).toFixed(1);
            lastNodeTimestamp = now;

            const updates = chunk as Record<string, Record<string, unknown>>;

            if ("router" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🔍 意图路由分析完成 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("execute_tools" in updates) {
              const messages = updates.execute_tools.messages as Array<{ name?: string }> | undefined;
              const firstMessageName = messages?.[0]?.name ?? "Unknown";
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "TOOL_STATUS", content: `${ToolNameMap[firstMessageName] || "Unknown Tool"}` })}\n\n`,
                ),
              );

              const toolPayload = updates.execute_tools as ToolPayload;
              if (toolPayload?.pendingDiffResult) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "TEXT", content: toolPayload.pendingDiffResult })}\n\n`,
                  ),
                );
              }
            }

            if ("summarize" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `📦 历史上下文压缩精炼完成 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }
          }

          const graphSnapshot = await graph.getState({
            configurable: { thread_id: sessionId },
          });
          finalState = graphSnapshot.values as AgentStateValues;
        } catch (graphErr) {
          console.error("LangGraph 运行期异常:", graphErr);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "ERROR", content: "Agent 思考流中断" })}\n\n`,
            ),
          );
          controller.close();
          return;
        }

        const totalGraphElapsed = (
          (performance.now() - totalGraphStart) /
          1000
        ).toFixed(1);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "STATUS", content: `✨ 拓扑网络演算完毕，总耗时: ${totalGraphElapsed}s。开始接入大模型深度推理...` })}\n\n`,
          ),
        );

        const memorySummaryText = finalState?.summary
          ? `\n\n[此前久远的对话背景历史摘要]:\n${finalState.summary}`
          : "";

        // 🛡️ 核心修复 2：系统提示词强压迫，禁止模型在最终回复阶段输出任何内部 XML
        const systemPrompt = {
          role: "system",
          content: `You are an expert AI software architect and coding agent. Respond in Chinese.
⚠️ CRITICAL OUTPUT PROTOCOL:
1. Before writing any final response, you MUST perform deep reasoning and planning. 
2. You MUST output your internal chain of thought wrapped inside <think> and </think> tags.
3. 🚫 STRICT RULE: The tool execution phase is OVER. DO NOT output ANY raw XML tool calls (like <function_calls>, <invoke>, <tool_call>). Provide your answer directly using standard Markdown!${memorySummaryText}`,
        };

        const recentMessages = (finalState?.messages || [])
          .filter((m) => m._getType() !== "system")
          .map((m) => {
            const type = m._getType();
            if (type === "human")
              return { role: "user" as const, content: m.content as string };
            if (type === "ai") {
              const aiM = m as AIMessage;
              return {
                role: "assistant" as const,
                content: aiM.content as string,
                tool_calls:
                  aiM.tool_calls && aiM.tool_calls.length > 0
                    ? aiM.tool_calls.map((tc) => ({
                        id: tc.id,
                        type: "function" as const,
                        function: {
                          name: tc.name,
                          arguments: JSON.stringify(tc.args),
                        },
                      }))
                    : undefined,
              };
            }
            if (type === "tool") {
              const toolM = m as ToolMessage;
              return {
                role: "tool" as const,
                content: toolM.content as string,
                tool_call_id: toolM.tool_call_id,
              };
            }
            return { role: "user" as const, content: String(m.content) };
          });

        try {
          const streamResponse = await fetch(QWEN_STREAM_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
            },
            body: JSON.stringify({
              model: "qwen3.7-plus",
              messages: [systemPrompt, ...recentMessages],
              stream: true,
            }),
          });

          if (!streamResponse.ok) {
            const errorText = await streamResponse.text();
            console.error("千问报错详情:", errorText);

            const errorPayload = {
              type: "STATUS",
              content: "❌ 大模型调用失败，请检查账户余额或上下文长度。",
            };
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(errorPayload)}\n\n`,
              ),
            );
            throw new Error(`Qwen API return status ${streamResponse.status}`);
          }

          const reader = streamResponse.body!.getReader();
          let buffer = "";
          let isThinking = false;

          // ⚡ 实例化高级过滤器
          const xmlFilter = new XMLStreamFilter();

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // 结尾时把缓冲器里确认无害的残留文本吐干净
              const leftOver = xmlFilter.process("");
              if (leftOver) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "TEXT", content: leftOver })}\n\n`,
                  ),
                );
              }
              console.log("✅ 流式传输正常结束");
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data:")) continue;
              const dataJson = trimmed.slice("data:".length).trim();
              if (dataJson === "[DONE]") break;

              try {
                const parsed = JSON.parse(dataJson) as StreamDeltaResponse;
                const rawText = parsed.choices?.[0]?.delta?.content || "";

                if (rawText) {
                  // ⚡ 将原始 token 喂给过滤器，拿到干净的文本
                  const cleanText = xmlFilter.process(rawText);

                  if (cleanText) {
                    // 注意：<think> 会原样通过过滤器，所以前端的思考骨架屏逻辑完全不受影响
                    if (cleanText.includes("<think>")) {
                      isThinking = true;
                    }

                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ type: "TEXT", content: cleanText })}\n\n`,
                      ),
                    );

                    if (cleanText.includes("</think>")) {
                      isThinking = false;
                      console.log(
                        `模型思考完毕，转入正式回答，状态锁定为: ${String(isThinking)}`,
                      );
                    }
                  }
                }
              } catch {
                // 忽略残缺流数据
              }
            }
          }
        } catch (qwenErr) {
          console.error("千问流读取异常:", qwenErr);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(outputStream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: unknown) {
    console.error("❌ [Fatal Error]:", error);
    return NextResponse.json(
      { error: "SERVER_INTERNAL_FATAL" },
      { status: 500 },
    );
  }
}
