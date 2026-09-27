import { create } from 'zustand';

export type Persona = 'steward' | 'ops' | 'governance';

interface TemporalState {
  asOfDate: string;
  knowledgeDate: string;
  persona: Persona;
  setAsOfDate: (date: string) => void;
  setKnowledgeDate: (date: string) => void;
  setPersona: (persona: Persona) => void;
  resetToToday: () => void;
}

const getToday = () => new Date().toISOString().split('T')[0];

export const useTemporalStore = create<TemporalState>((set) => ({
  asOfDate: getToday(),
  knowledgeDate: getToday(),
  persona: 'ops',
  setAsOfDate: (date) => set({ asOfDate: date }),
  setKnowledgeDate: (date) => set({ knowledgeDate: date }),
  setPersona: (persona) => set({ persona }),
  resetToToday: () => set({ asOfDate: getToday(), knowledgeDate: getToday() }),
}));
