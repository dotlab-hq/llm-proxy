import { WebSearchManager, type WebSearchResponse } from './WebSearchManager';
import { CONFIG } from '@/utils/schema.lookup';

export class WebSearchHandler {
  private webSearchManager: WebSearchManager;

  constructor() {
    this.webSearchManager = new WebSearchManager();
  }

  async prepareAnthropicWebSearch(body: any): Promise<{
    body: any;
    searchResponse?: WebSearchResponse;
    errorResponse?: { status: number; body: any };
  }> {
    const startedAt = Date.now();
    if (!this.shouldUseAnthropicWebSearch(body)) {
      return { body };
    }

    if (!this.webSearchManager.isEnabled()) {
      return {
        body,
        errorResponse: {
          status: 503,
          body: {
            error: {
              message: 'Web search requested but no web search provider is configured',
              type: 'invalid_request_error',
            }
          }
        }
      };
    }

    const query = this.extractAnthropicWebSearchQuery(body);
    if (!query) {
      return {
        body,
        errorResponse: {
          status: 400,
          body: {
            error: {
              message: 'Unable to derive a web search query from the Anthropic messages payload',
              type: 'invalid_request_error',
            }
          }
        }
      };
    }

    const searchDefaults = CONFIG.tools?.webSearch?.defaults;
    const searchResponse = await this.webSearchManager.search(query, {
      maxResults: searchDefaults?.maxResults ?? 6,
      expand: searchDefaults?.expandQueries,
      maxExpandedQueries: searchDefaults?.maxExpandedQueries,
      parallelQueries: searchDefaults?.parallelQueries,
      softTimeoutMs: searchDefaults?.softTimeoutMs,
      providerTimeoutMs: searchDefaults?.providerTimeoutMs,
    });
    console.info(`[web-search] anthropic_prepare durationMs=${Date.now() - startedAt} provider=${searchResponse.provider} cached=${searchResponse.cached} citations=${searchResponse.citations.length}`);
    return {
      body: this.injectAnthropicWebSearchContext(body, searchResponse),
      searchResponse,
    };
  }

  shouldUseAnthropicWebSearch(body: any): boolean {
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const hasWebSearchTool = tools.some((tool: any) =>
      tool?.name === 'web_search'
      || (typeof tool?.type === 'string' && tool.type.startsWith('web_search_'))
      || tool?.type === 'web_search'
    );

    if (!hasWebSearchTool) return false;

    // Hermes includes the server tool definition on every request. The
    // definition only makes the tool available; it does not mean that the
    // model chose to use it. Searching here on tool availability caused an
    // external search for every ordinary turn. Only honor an explicit tool
    // choice, while leaving `auto` (and an omitted choice) to the model.
    const toolChoice = body?.tool_choice;
    if (typeof toolChoice === 'string') {
      return toolChoice === 'web_search';
    }
    return toolChoice?.type === 'tool'
      && (toolChoice?.name === 'web_search' || toolChoice?.tool?.name === 'web_search');
  }

  extractAnthropicWebSearchQuery(body: any): string | null {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'user') continue;
      const text = this.extractAnthropicTextContent(message?.content);
      if (text) return text;
    }
    return null;
  }

  injectAnthropicWebSearchContext(body: any, searchResponse: WebSearchResponse): any {
    const searchPrompt = this.buildAnthropicWebSearchPrompt(searchResponse);
    const existingSystem = body?.system;
    const systemBlocks = typeof existingSystem === 'string'
      ? [{ type: 'text', text: existingSystem }]
      : Array.isArray(existingSystem) ? existingSystem : [];

    return {
      ...body,
      tools: Array.isArray(body?.tools)
        ? body.tools.filter((tool: any) =>
            tool?.name !== 'web_search'
            && tool?.type !== 'web_search'
            && !(typeof tool?.type === 'string' && tool.type.startsWith('web_search_'))
          )
        : body?.tools,
      system: [
        ...systemBlocks,
        {
          type: 'text',
          text: searchPrompt,
        },
      ],
    };
  }

  buildAnthropicWebSearchPrompt(searchResponse: WebSearchResponse): string {
    const citations = searchResponse.citations
      .map((citation, index) => `[${index + 1}] ${citation.title} - ${citation.url}\n${citation.snippet}`)
      .join('\n\n');

    return [
      `Web search results for query: ${searchResponse.query}`,
      'Use these results while answering. Cite supporting sources inline as [1], [2], etc.',
      citations,
    ].join('\n\n');
  }

  attachAnthropicWebSearchMetadata(payload: any, searchResponse?: WebSearchResponse): any {
    if (!searchResponse || !payload || typeof payload !== 'object' || !Array.isArray(payload.content)) {
      return payload;
    }

    const webSearchBlocks = this.buildAnthropicWebSearchBlocks(searchResponse);

    return {
      ...payload,
      content: [
        ...webSearchBlocks,
        ...payload.content,
      ],
      usage: this.attachAnthropicWebSearchUsage(payload.usage),
    };
  }

  private attachAnthropicWebSearchUsage(usage: any): any {
    const baseUsage = usage && typeof usage === 'object' ? { ...usage } : {};
    return {
      ...baseUsage,
      server_tool_use: {
        ...(baseUsage.server_tool_use ?? {}),
        web_search_requests: (baseUsage.server_tool_use?.web_search_requests ?? 0) + 1,
      },
    };
  }

  private buildAnthropicWebSearchBlocks(searchResponse: WebSearchResponse): any[] {
    const toolUseId = `srvtoolu_${Date.now().toString(36)}`;
    const toolResultContent = searchResponse.citations.map((citation) => ({
      type: 'web_search_result',
      url: citation.url,
      title: citation.title,
      encrypted_content: this.buildWebSearchEncryptedContent(citation.title, citation.url, citation.snippet),
    }));

    return [
      {
        type: 'server_tool_use',
        id: toolUseId,
        name: 'web_search',
        input: {
          query: searchResponse.query,
        },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: toolUseId,
        content: toolResultContent,
      },
    ];
  }

  private buildWebSearchEncryptedContent(title: string, url: string, snippet: string): string {
    return Buffer.from(JSON.stringify({ title, url, snippet })).toString('base64');
  }

  private extractAnthropicTextContent(content: any): string {
    if (typeof content === 'string') {
      return content.trim();
    }
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
      .map((block: any) => block.text)
      .join(' ')
      .trim();
  }
}

export const webSearchHandler = new WebSearchHandler();
