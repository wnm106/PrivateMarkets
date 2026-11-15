import { redirect } from 'next/navigation';

/** The pipeline is now the deal-pipeline surface. Keep old links and bookmarks working. */
export default async function PipelineRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === 'string') params.set(key, value);
  }
  const query = params.toString();
  redirect(query ? `/s/deal-pipeline?${query}` : '/s/deal-pipeline');
}
