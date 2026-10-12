import { create } from 'zustand';

export type Persona = 'steward' | 'ops' | 'governance';

interface TemporalState {
  asOfDate: string;
  knowledgeDate: string;
  persona: Persona;
  /** Whether the assistant popout is open. Shared so the top bar icon can toggle it. */
  chatOpen: boolean;
  setAsOfDate: (date: string) => void;
  setKnowledgeDate: (date: string) => void;
  setPersona: (persona: Persona) => void;
  setChatOpen: (open: boolean) => void;
  toggleChat: () => void;
  resetToToday: () => void;
}

const getToday = () => new Date().toISOString().split('T')[0];

export const useTemporalStore = create<TemporalState>((set) => ({
  asOfDate: getToday(),
  knowledgeDate: getToday(),
  persona: 'ops',
  chatOpen: false,
  setAsOfDate: (date) => set({ asOfDate: date }),
  setKnowledgeDate: (date) => set({ knowledgeDate: date }),
  setPersona: (persona) => set({ persona }),
  setChatOpen: (open) => set({ chatOpen: open }),
  toggleChat: () => set((state) => ({ chatOpen: !state.chatOpen })),
  resetToToday: () => set({ asOfDate: getToday(), knowledgeDate: getToday() }),
}));
