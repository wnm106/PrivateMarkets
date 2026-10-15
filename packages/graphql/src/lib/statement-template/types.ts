export type StatementSourceKind = 'image' | 'file' | 'paste';

export type StatementMatchKind = 'exact' | 'alias' | 'manual' | 'new';

export interface StatementSource {
  sourceName: string;
  sourceKind: StatementSourceKind;
  text: string;
}

export interface CatalogAttribute {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  aliases?: string[];
}

export interface ParsedLine {
  label: string;
  value?: string;
  dataType: string;
}

export interface ParsedSection {
  name: string;
  lines: ParsedLine[];
}

export interface ParsedStatement {
  sourceName: string;
  sourceKind: StatementSourceKind;
  sections: ParsedSection[];
}

export interface StatementLineDraft {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  displayOrder: number;
  displayLabel: string;
  matchKind: StatementMatchKind;
  confidence: number;
  isNew: boolean;
  required: boolean;
  aliases: string[];
  sampleValue: string | null;
  sources: string[];
}

export interface StatementSectionDraft {
  sectionCode: string;
  sectionName: string;
  displayOrder: number;
  lines: StatementLineDraft[];
}

export interface StatementCatalogEntry {
  attributeCode: string;
  attributeName: string;
  dataType: string;
}

export interface StatementTemplateDraft {
  sections: StatementSectionDraft[];
  warnings: string[];
  catalog: StatementCatalogEntry[];
}
