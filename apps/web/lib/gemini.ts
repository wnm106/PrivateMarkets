export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export interface ChatContext {
  page?: string;
  entityCode?: string;
  domainCode?: string;
  entityId?: string;
}

export interface ChatResponse {
  text: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, any>;
  }>;
}

export async function sendGeminiMessage(
  messages: ChatMessage[],
  context?: ChatContext
): Promise<string> {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages, context }),
    });

    let data;
    const text = await response.text();
    
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      console.error('[Chat] Failed to parse response:', text);
      throw new Error(`Invalid response from server: ${response.status} ${response.statusText}`);
    }

    if (!response.ok) {
      throw new Error(data.error || `API error: ${response.status}`);
    }

    return data.text || 'No response received.';
  } catch (error) {
    console.error('Chat API error:', error);
    throw error;
  }
}
