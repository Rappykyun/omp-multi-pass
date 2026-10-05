// Synthetic credentials and protocol events; no real account data.
export function token(accountId: string): string {
  return (
    "header." +
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
    ).toString("base64url") +
    ".signature"
  );
}
export function events(
  mode: "success" | "text-error" | "tool-error" | "thinking-error",
) {
  const response = {
    id: "response-test",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      total_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const records: Record<string, unknown>[] = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress" },
    },
  ];
  if (mode === "tool-error") {
    records.push({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "tool",
        type: "function_call",
        call_id: "call-test",
        name: "test_tool",
        arguments: "",
      },
    });
    records.push({
      type: "response.function_call_arguments.delta",
      item_id: "tool",
      output_index: 0,
      delta: '{"value":',
    });
  } else if (mode === "thinking-error") {
    records.push({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "thought", type: "reasoning", summary: [] },
    });
    records.push({
      type: "response.reasoning_summary_part.added",
      item_id: "thought",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
    records.push({
      type: "response.reasoning_summary_text.delta",
      item_id: "thought",
      output_index: 0,
      summary_index: 0,
      delta: "partial thought",
    });
  } else {
    records.push({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "message", type: "message", role: "assistant", content: [] },
    });
    records.push({
      type: "response.content_part.added",
      item_id: "message",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    records.push({
      type: "response.output_text.delta",
      item_id: "message",
      output_index: 0,
      content_index: 0,
      delta: mode === "success" ? "OK" : "partial",
    });
  }
  if (mode === "success") {
    const item = {
      id: "message",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "OK", annotations: [] }],
    };
    records.push({ type: "response.output_item.done", output_index: 0, item });
    records.push({
      type: "response.completed",
      response: { ...response, output: [item] },
    });
  } else
    records.push({
      type: "response.failed",
      response: {
        ...response,
        status: "failed",
        error: { code: "usage_limit_reached", message: "Usage limit reached" },
      },
    });
  return records
    .map((record) => "data: " + JSON.stringify(record) + "\n\n")
    .join("");
}
