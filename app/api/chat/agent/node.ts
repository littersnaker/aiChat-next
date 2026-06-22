import {
  AIMessage,
  RemoveMessage,
  ToolMessage,
} from "@langchain/core/messages";
import fs from "fs";
import path from "path";
import { tools } from "../tools";
import { AgentState } from "./state";
import { execSync } from "child_process";
const QWEN_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

interface QwenMessageResponse {
  choices?: Array<{
    message?: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}
interface QwenSummaryResponse {
  choices?: Array<{ message?: { content: string | null } }>;
}

// --------------------------------------------------------
// 节点 A: 严格路由节点
// --------------------------------------------------------
export async function routerNode(
  state: typeof AgentState.State,
): Promise<Record<string, unknown>> {
  const recentMessages = state.messages.slice(-6);

  const firstStageContext = [
    {
      role: "system",
      content: `You are an autonomous coding agent.

                  Role:
                  Senior Full Stack Engineer.

                  Capabilities:
                  - Explore project structure
                  - Search source code
                  - Read files
                  - Modify files
                  - Execute commands
                  - Analyze errors
                  - Fix issues

                  Tool Strategy:

                  1. Unknown project?
                    -> list_directory

                  2. Unknown file location?
                    -> search_codebase

                  3. Before modifying code?
                    -> read_file_from_disk

                  4. Need code changes?
                    -> propose_file_change

                  5. Need validation?
                    -> run_terminal_command

                  Rules:

                  - Never assume file contents.
                  - Always inspect before modifying.
                  - Prefer tool usage over guessing.
                  - Continue using tools until enough information is gathered.
                  - Return NO_TOOL only when no further tool usage is required.
                The tool execution phase is OVER. DO NOT output ANY raw XML tool calls  
                  `,
    },
    {
      role: "user",
      content: `Analyze the following conversation history:\n${JSON.stringify(recentMessages, null, 2)}\n\nAction required: If a tool is needed, call it. If not, output 'NO_TOOL'.`,
    },
  ];

  const res = await fetch(QWEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "qwen3.6-plus-2026-04-02",
      messages: firstStageContext,
      tools: tools,
      tool_choice: "auto",
      stream: false,
    }),
  });

  const result = (await res.json()) as QwenMessageResponse;
  const assistantMessage = result.choices?.[0]?.message;

  if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
    const aiMessage = new AIMessage({
      content: assistantMessage.content || "",
      tool_calls: assistantMessage.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        type: "tool_call" as const,
      })),
    });

    return {
      routeDecision: "TOOL_CALL",
      messages: [aiMessage],
    };
  }

  return { routeDecision: "NO_TOOL" };
}

// --------------------------------------------------------
// 磁盘物理辅助操作
// --------------------------------------------------------
async function proposeCodeChange(
  filePath: string,
  fileContent: string,
): Promise<string> {
  try {
    const rootPath = process.cwd();
    const safePath = path.join(
      rootPath,
      filePath.startsWith("./") ? filePath : path.join("./", filePath),
    );
    if (!fs.existsSync(safePath)) {
      fs.writeFileSync(safePath, fileContent, "utf-8");
      return JSON.stringify({ msg: `🆕 成功新建了文件：${filePath}` });
    }
    const pendingPath = `${safePath}.pending`;
    fs.writeFileSync(pendingPath, fileContent, "utf-8");
    return JSON.stringify({
      type: "DIFF_READY",
      payload: {
        original: filePath,
        pending: `${filePath}.pending`,
        message: "我已将修改生成在 .pending 文件中",
      },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `❌ 计算补丁失败: ${errorMessage}`;
  }
}
async function getSafePath(filePath: string): Promise<string> {
  const rootPath = process.cwd();
  // 强制移除开头的 ./ 或 /，确保它始终是相对于 rootPath 的
  const normalizedPath = filePath.replace(/^(\.\/|\/)/, "");
  return path.join(rootPath, normalizedPath);
}

async function readFileFromLocalDisk(filePath: string): Promise<string> {
  try {
    const safePath = await getSafePath(filePath); // 统一调用
    if (!fs.existsSync(safePath))
      return `❌ 未找到文件: ${filePath} (实际查找路径: ${safePath})`;
    return fs.readFileSync(safePath, "utf-8");
  } catch (error: unknown) {
    return `❌ 读取失败: ${error}`;
  }
}
async function listDirectory(dirPath = "."): Promise<string> {
  try {
    const rootPath = process.cwd();
    const targetDir = path.join(rootPath, dirPath);

    const files = fs.readdirSync(targetDir, {
      withFileTypes: true,
    });

    return JSON.stringify(
      files.map((item) => ({
        name: item.name,
        type: item.isDirectory() ? "directory" : "file",
      })),
      null,
      2,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return `❌ 读取目录失败: ${errorMessage}`;
  }
}
async function searchCodebase(keyword: string): Promise<string> {
  try {
    const results: string[] = [];

    function walk(dir: string) {
      const entries = fs.readdirSync(dir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".next" ||
          entry.name === ".git"
        ) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          try {
            const content = fs.readFileSync(fullPath, "utf8");

            if (content.includes(keyword)) {
              results.push(path.relative(process.cwd(), fullPath));
            }
          } catch {}
        }
      }
    }

    walk(process.cwd());

    return JSON.stringify(results, null, 2);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return `❌ 搜索失败: ${errorMessage}`;
  }
}
async function runTerminalCommand(command: string): Promise<string> {
  try {
    const result = execSync(command, {
      cwd: process.cwd(),
      encoding: "buffer",
      timeout: 15000,
    });
    return result.toString("utf-8");
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
async function getDiff(filePath: string): Promise<string> {
  try {
    const original = path.join(process.cwd(), filePath);

    const pending = `${original}.pending`;

    if (!fs.existsSync(pending)) {
      return "No pending diff found";
    }

    const result = execSync(`git diff --no-index "${original}" "${pending}"`, {
      encoding: "utf8",
    });

    return result;
  } catch (error: unknown) {
    const err = error as {
      stdout?: string;
      message?: string;
    };

    return err.stdout ?? err.message ?? "Diff failed";
  }
}
async function applyFileChange(filePath: string): Promise<string> {
  const original = path.join(process.cwd(), filePath);

  const pending = `${original}.pending`;

  if (!fs.existsSync(pending)) {
    return "❌ pending 文件不存在";
  }

  fs.copyFileSync(pending, original);

  fs.unlinkSync(pending);

  return "✅ 修改已应用";
}
async function proposeFileChange(
  filePath: string,
  fileContent: string,
): Promise<string> {
  try {
    const safePath = await getSafePath(filePath);

    // 如果父目录不存在，先创建父目录（防止报错）
    const dir = path.dirname(safePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(safePath)) {
      fs.writeFileSync(safePath, fileContent, "utf-8");
      return JSON.stringify({ msg: `🆕 成功新建了文件：${filePath}` });
    }

    const pendingPath = `${safePath}.pending`;
    fs.writeFileSync(pendingPath, fileContent, "utf-8");
    return JSON.stringify({
      type: "DIFF_READY",
      payload: {
        original: filePath,
        pending: `${filePath}.pending`,
        message: "我已将修改生成在 .pending 文件中",
      },
    });
  } catch (error: unknown) {
    return `❌ 操作失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}
// --------------------------------------------------------
// 节点 B: 工具执行节点 (修复：返回标准 ToolMessage 实例)
// --------------------------------------------------------
export async function executeToolsNode(
  state: typeof AgentState.State,
): Promise<Record<string, unknown>> {
  const lastMessage = state.messages[state.messages.length - 1];

  if (!AIMessage.isInstance(lastMessage) || !lastMessage.tool_calls) {
    return { messages: [] };
  }

  const toolOutputs: ToolMessage[] = [];

  for (const toolCall of lastMessage.tool_calls) {
    const args = toolCall.args as Record<string, string>;
    const filePath = args.filePath || "";
    const fileContent = args.fileContent || "";
    let result = "";
    switch (toolCall.name) {
      case "propose_file_change":
        result = await proposeFileChange(filePath, fileContent);
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        // 自动追加 Diff 检查
        const diff = await getDiff(filePath);
        toolOutputs.push(
          new ToolMessage({
            content: diff,
            tool_call_id: `${toolCall.id}-diff`,
            name: "get_diff",
          }),
        );
        break;
      case "list_directory":
        result = await listDirectory(args.dirPath || ".");
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      case "search_codebase":
        result = await searchCodebase(args.keyword || "");
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      case "apply_file_change":
        result = await applyFileChange(filePath);
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      case "run_terminal_command":
        result = await runTerminalCommand(args.command || "");
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      case "read_file_from_disk":
        result = await readFileFromLocalDisk(filePath);
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      default:
        console.warn(`Unknown tool: ${toolCall.name}`);
    }
  }

  return { messages: toolOutputs };
}
// --------------------------------------------------------
// ⚡ 新增节点 C: Token 智能化压缩与滚动摘要节点
// --------------------------------------------------------
export async function summarizeHistoryNode(
  state: typeof AgentState.State,
): Promise<Record<string, unknown>> {
  const messages = state.messages || [];
  const summary = state.summary || "";

  // 🎯 优化一：【数量水位线哨兵】
  // 如果当前总消息数还没有超过 14 条（或者你指定的 MAX_CONTEXT_MESSAGES），
  // 证明上下文非常轻量，不需要做任何压缩，直接 0 毫秒闪回通过！
  if (messages.length < 14) {
    return {};
  }

  // 只有在消息爆满时，才裁剪最老的 4 条消息进行摘要融合
  const messagesToSummarize = messages.slice(0, 4);

  const summaryPrompt = `
    你是一个记忆管理专家。请根据现有的摘要内容以及新提供的对话历史，将它们融合成一段最新、最精炼的中文上下文大纲。
    要求：保留所有关键的工程进展、讨论过的文件名和核心结论，去除寒暄。字数控制在 200 字以内。

    [当前已有历史摘要]:
    ${summary || "暂无历史摘要"}

    [需要加入的新对话历史]:
    ${JSON.stringify(
      messagesToSummarize.map((m) => ({
        role: m._getType(),
        content: m.content,
      })),
      null,
      2,
    )}
  `;

  try {
    const res = await fetch(QWEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "qwen3.7-max-2026-06-08",
        messages: [{ role: "user", content: summaryPrompt }],
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`Summary API HTTP error! status: ${res.status}`);
    }

    const result = (await res.json()) as QwenSummaryResponse;
    const nextSummary = result.choices?.[0]?.message?.content || summary;

    // 构造 LangGraph 的老消息清除指令
    const deletionMessages = messagesToSummarize
      .map((m) => {
        const id = m.id;
        return id ? new RemoveMessage({ id }) : null;
      })
      .filter((m): m is RemoveMessage => m !== null);

    return {
      messages: deletionMessages,
      summary: nextSummary,
    };
  } catch (error) {
    console.error("⚠️ Token 摘要压缩失败，跳过此次压缩:", error);
    return {};
  }
}
