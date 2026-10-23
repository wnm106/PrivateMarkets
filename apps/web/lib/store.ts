import { create } from 'zustand';
import {
  CHAT_VOICE_STORAGE_KEY,
  DEFAULT_CHAT_VOICE,
  type ChatVoice,
} from './chat-voice';

export type Persona = 'steward' | 'ops' | 'governance';

interface TemporalState {
  asOfDate: string;
  knowledgeDate: string;
  persona: Persona;
  /** How the assistant speaks. Persisted in the browser. */
  chatVoice: ChatVoice;
  /** Whether the assistant popout is open. Shared so the top bar icon can toggle it. */
  chatOpen: boolean;
  setAsOfDate: (date: string) => void;
  setKnowledgeDate: (date: string) => void;
  setPersona: (persona: Persona) => void;
  setChatVoice: (voice: ChatVoice) => void;
  setChatOpen: (open: boolean) => void;
  toggleChat: () => void;
  resetToToday: () => void;
}

const getToday = () => new Date().toISOString().split('T')[0];

export const useTemporalStore = create<TemporalState>((set) => ({
  asOfDate: getToday(),
  knowledgeDate: getToday(),
  persona: 'ops',
  chatVoice: DEFAULT_CHAT_VOICE,
  chatOpen: false,
  setAsOfDate: (date) => set({ asOfDate: date }),
  setKnowledgeDate: (date) => set({ knowledgeDate: date }),
  setPersona: (persona) => set({ persona }),
  setChatVoice: (chatVoice) => {
    try {
      window.localStorage.setItem(CHAT_VOICE_STORAGE_KEY, chatVoice);
    } catch {
      // Private mode or a blocked storage API should not stop the switch.
    }
    set({ chatVoice });
  },
  setChatOpen: (open) => set({ chatOpen: open }),
  toggleChat: () => set((state) => ({ chatOpen: !state.chatOpen })),
  resetToToday: () => set({ asOfDate: getToday(), knowledgeDate: getToday() }),
}));
