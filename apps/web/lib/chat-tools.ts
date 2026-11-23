/**
 * The assistant's own tools, registered once for the chat route and the
 * confirm route, so a confirmed call runs the same tool the model asked for.
 * Server only.
 */
import { ToolRegistry } from '@tapestrai/mcp-server/src/lib/tool-registry';
import { registerDomainTools } from '@tapestrai/mcp-server/src/tools/domain-tools';
import { registerLineageTools } from '@tapestrai/mcp-server/src/tools/lineage-tools';
import { registerDocumentTools } from '@tapestrai/mcp-server/src/tools/document-tools';
import { registerOverrideTools } from '@tapestrai/mcp-server/src/tools/override-tools';
import { registerDQTools } from '@tapestrai/mcp-server/src/tools/dq-tools';
import { registerDQRuleTools } from '@tapestrai/mcp-server/src/tools/dq-rule-tools';
import { registerWorkflowTools } from '@tapestrai/mcp-server/src/tools/workflow-tools';
import { registerImportMapTools } from '@tapestrai/mcp-server/src/tools/import-map-tools';
import { registerPositionFileTools } from '@tapestrai/mcp-server/src/tools/position-file-tools';
import { registerSpecialistTools } from '@tapestrai/mcp-server/src/tools/specialist-tools';
import { registerComplianceTools } from '@tapestrai/mcp-server/src/tools/compliance-tools';
import { registerReportingTools } from '@tapestrai/mcp-server/src/tools/reporting-tools';
import { registerQueryTools } from '@tapestrai/mcp-server/src/tools/query-data';
import { registerNarrativeTools } from '@tapestrai/mcp-server/src/tools/narrative-tools';
import { registerExternalIdTools } from '@tapestrai/mcp-server/src/tools/external-id-tools';

export const toolRegistry = new ToolRegistry();
registerDomainTools(toolRegistry);
registerLineageTools(toolRegistry);
registerDocumentTools(toolRegistry);
registerOverrideTools(toolRegistry);
registerDQTools(toolRegistry);
registerDQRuleTools(toolRegistry);
registerWorkflowTools(toolRegistry);
registerImportMapTools(toolRegistry);
registerPositionFileTools(toolRegistry);
registerSpecialistTools(toolRegistry);
registerComplianceTools(toolRegistry);
registerReportingTools(toolRegistry);
registerQueryTools(toolRegistry);
registerNarrativeTools(toolRegistry);
registerExternalIdTools(toolRegistry);
