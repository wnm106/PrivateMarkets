export type {
  CatalogAttribute,
  StatementCatalogEntry,
  StatementLineDraft,
  StatementMatchKind,
  StatementSectionDraft,
  StatementSource,
  StatementSourceKind,
  StatementTemplateDraft,
} from './types';
export { parseStatementSource, visionJsonToStatementText, sectionsFromMatrix } from './parse';
export { buildStatementTemplate, retargetLine } from './build';
export { labelMatchesAlias, labelsEquivalent, normalizeLabel, toAttributeCode } from './normalize';
export { STATEMENT_SHAPES, isDomainCode, normalizeDomainCode, statementKindCode } from './entities';
export { loadStatementCatalog, applyStatementTemplate, requireDomain } from './persist';
export type { ApplyStatementTemplateInput, ApplyStatementTemplateOutput } from './persist';
