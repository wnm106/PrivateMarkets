'use client';

import { useEffect, useState } from 'react';
import { graphqlQuery, HIDDEN_ATTRIBUTE_CODES_QUERY } from '@/lib/graphql';
import { isHiddenAttribute, RESTRICTED_TEXT } from '@/lib/restricted-values';

export { isHiddenAttribute, RESTRICTED_TEXT };

/**
 * Attributes whose values this person is not cleared to see
 * (20261126170000_attribute_access_levels). The database already leaves their
 * values out; this lets a screen say "Restricted" instead of showing a blank,
 * and stop offering to edit them. Read once per page load.
 */
let pending: Promise<ReadonlySet<string>> | null = null;

function load(): Promise<ReadonlySet<string>> {
  if (!pending) {
    pending = graphqlQuery<{ hiddenAttributeCodes: string[] }>(HIDDEN_ATTRIBUTE_CODES_QUERY, {}, 'network-only')
      .then((result) => new Set(result.data?.hiddenAttributeCodes ?? []))
      .catch(() => new Set<string>());
  }
  return pending;
}

const EMPTY: ReadonlySet<string> = new Set();

export function useHiddenAttributes(): ReadonlySet<string> {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(EMPTY);
  useEffect(() => {
    let live = true;
    void load().then((codes) => {
      if (live) setHidden(codes);
    });
    return () => {
      live = false;
    };
  }, []);
  return hidden;
}
