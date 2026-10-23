/** How the assistant speaks. Independent of the user's security role. */
export type ChatVoice = 'business' | 'steward' | 'technical';

export const CHAT_VOICE_STORAGE_KEY = 'tapestr.chatVoice';

export const DEFAULT_CHAT_VOICE: ChatVoice = 'business';

export const CHAT_VOICES: Array<{ id: ChatVoice; label: string; hint: string }> = [
  {
    id: 'business',
    label: 'Business',
    hint: 'Plain answers for people reading the data',
  },
  {
    id: 'steward',
    label: 'Steward',
    hint: 'Sources, changes, and data quality',
  },
  {
    id: 'technical',
    label: 'Technical',
    hint: 'Model codes, precedence, and lineage',
  },
];

const DESIGNER_CAVEAT =
  'When you are designing a dashboard or narrative, keep the explanation in this voice, but any json proposal must still use the real attribute and relationship codes returned by the tools.';

const INSTRUCTIONS: Record<ChatVoice, string> = {
  business: `Speak to someone reading investment data: a portfolio manager, analyst, or client.
Lead with the answer in everyday language: the value, what it means, whether it changed, and since when.
Name a source the way a person would (for example "internal records" or "Bloomberg"), not as a system code.
Leave out attribute codes, precedence ranks, golden-record mechanics, bi-temporal records, system time, and other schema terms unless the user asks for them.
Use a short sentence or a few scannable bullets. ${DESIGNER_CAVEAT}`,

  steward: `Speak to a data steward or operations user who maintains the record.
Explain where a value came from, whether sources disagree, when it took effect, and any quality issue, in operational language.
Use source names, dates, and the business name of the field. Mention an attribute code only when two fields could be confused.
Skip implementation terms such as bi-temporal, precedence rank, system time, and EAV unless the user asks how the platform stores the change.
Be concrete and brief. ${DESIGNER_CAVEAT}`,

  technical: `Speak to someone configuring or debugging the data model.
Include attribute codes, source codes, precedence, effective dates, and knowledge dates when they explain the answer.
Platform terms such as golden source, valid time, system time, and lineage are appropriate. Say how the value was resolved when that is the question.
Stay precise and brief; do not explain the model when the user asked a narrow question. ${DESIGNER_CAVEAT}`,
};

export function isChatVoice(value: unknown): value is ChatVoice {
  return value === 'business' || value === 'steward' || value === 'technical';
}

export function readStoredChatVoice(): ChatVoice {
  if (typeof window === 'undefined') return DEFAULT_CHAT_VOICE;
  try {
    const stored = window.localStorage.getItem(CHAT_VOICE_STORAGE_KEY);
    return isChatVoice(stored) ? stored : DEFAULT_CHAT_VOICE;
  } catch {
    return DEFAULT_CHAT_VOICE;
  }
}

export function chatVoiceInstruction(voice: unknown): string {
  const id = isChatVoice(voice) ? voice : DEFAULT_CHAT_VOICE;
  return `\n\n## Voice\n${INSTRUCTIONS[id]}`;
}
