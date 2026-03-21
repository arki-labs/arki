/**
 * @arki/ai — Higher-level AI capabilities
 *
 * These are provider-agnostic, schema-validated, ready-to-use AI functions
 * that any app in the monorepo can import. All capabilities accept an optional
 * `StructuredLLMProvider` so callers control the model and temperature, and the
 * active provider is driven by the `LLM_PROVIDER` environment variable.
 */

export {
  classifyIntent,
  type ClassifiedIntent,
  type IntentType,
} from './intent-classification';

export {
  nameCluster,
  type ClusterName,
  type ClusterNamingContext,
  type ClusterType,
} from './cluster-naming';

export {
  analyzeContent,
  ContentAnalysisSchema,
  type ContentAnalysis,
  type ContentCategory,
  type ContentType,
  type EntityType,
  type ImportanceLevel,
} from './content-analysis';

export {
  classifyConnection,
  type ConnectionClassification,
  type ConnectionType,
} from './connection-classification';
