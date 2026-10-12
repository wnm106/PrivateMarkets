import { useQuery } from '@tanstack/react-query';
import { graphqlClient, DATA_SOURCES_QUERY } from '@/lib/graphql';
import { sources as hardcodedSources, SourceKey } from '@/lib/data';

interface Source {
  id: string;
  sourceCode: string;
  sourceName: string;
  sourceType: string;
  vendorName: string | null;
  feedFormat: string | null;
  feedFrequency: string | null;
  precedenceRank: number;
  isActive: boolean;
  isProtected: boolean;
  color: string | null;
  metadata: any;
  createdAt: string;
  updatedAt: string;
}

interface SourceWithKey extends Source {
  key: SourceKey;
}

// Convert hardcoded sources to the expected format
const fallbackSources: Record<string, SourceWithKey> = Object.entries(hardcodedSources).reduce(
  (acc, [key, source]) => {
    acc[key] = {
      id: key,
      sourceCode: key.toUpperCase(),
      sourceName: source.name,
      sourceType: key === 'manual' ? 'MANUAL' : key === 'derived' ? 'CALCULATED' : 'VENDOR',
      vendorName: null,
      feedFormat: null,
      feedFrequency: null,
      precedenceRank: 100,
      isActive: true,
      isProtected: key === 'manual',
      color: source.color,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      key: key as SourceKey,
    };
    return acc;
  },
  {} as Record<string, SourceWithKey>
);

export function useSources() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['sources'],
    queryFn: async () => {
      const result = await graphqlClient.query(DATA_SOURCES_QUERY, {}).toPromise();
      if (result.error) throw result.error;
      return result.data?.dataSources as Source[];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1,
  });

  // Convert API sources to the expected format
  const sources = data?.reduce((acc, source) => {
    const key = source.sourceCode.toLowerCase() as SourceKey;
    acc[key] = {
      ...source,
      key,
    };
    return acc;
  }, {} as Record<string, SourceWithKey>);

  // Return API sources if available, otherwise fall back to hardcoded
  const finalSources = sources && Object.keys(sources).length > 0 ? sources : fallbackSources;

  return {
    sources: finalSources,
    isLoading,
    error,
  };
}
