// Shared types for Responses ↔ Chat Completions conversion.

interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | null | Array<Record<string, unknown>>;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
}

interface ChatTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
}

interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
    tools?: ChatTool[];
    tool_choice?: unknown;
    reasoning_effort?: string;
    stop?: string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    seed?: number;
    stream_options?: { include_usage: boolean };
    [key: string]: unknown;
}

interface ChatCompletionResponse {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    system_fingerprint?: string;
    choices?: Array<{
        index?: number;
        message?: { role?: string; content?: string | null; tool_calls?: unknown[] };
        finish_reason?: string;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
    };
}

interface ResponsesRequest {
    model: string;
    input?: string | Array<Record<string, unknown>>;
    instructions?: string;
    max_output_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
    tools?: Array<Record<string, unknown>>;
    tool_choice?: unknown;
    reasoning?: Record<string, unknown>;
    reasoning_effort?: string;
    stop?: string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    seed?: number;
    [key: string]: unknown;
}

interface ResponsesOutputItem {
    type: string;
    [key: string]: unknown;
}

export interface FileSearchCallItem {
    id: string;
    queries: string[];
    status: 'completed' | 'failed';
    results?: Array<{
        file_id: string;
        filename?: string;
        text?: string;
        score?: number;
        attributes?: Record<string, string | number | boolean>;
    }>;
}

export interface ResponsesStreamState {
    responseId: string;
    model: string;
    created: number;
    contentBlockIndex: number;
    currentOutputIndex: number;
    hasEmittedResponse: boolean;
    currentTextBlockOpen: boolean;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    finished: boolean;
    requestStartedAt: number;
    firstEmissionLogged: boolean;
    textItems: Array<{ itemId: string; text: string }>;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    /** Raw DSML tool-call text emitted by models that do not support native tools. */
    dsmlBuffer: string;
    reasoningItems: Array<{ itemId: string; text: string }>;
    currentReasoningBlockOpen: boolean;
    reasoningBuffer: string;
    fileSearchCalls: FileSearchCallItem[];
}

export type {
    ChatMessage,
    ChatTool,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ResponsesRequest,
    ResponsesOutputItem,
};
