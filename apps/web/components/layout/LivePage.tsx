'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { RouteChatContext } from '@/lib/page-context';
import { readVisiblePage, type VisiblePage } from '@/lib/visible-page';
import { usePublishPageData, usePublishViewContext } from '@/lib/view-context';

/**
 * Baseline for every screen. A page can publish a more specific focus or a
 * richer payload; those replace this reading while that page is mounted.
 */
export function LivePage({ route }: { route: RouteChatContext }): null {
  const pathname = usePathname() || '/';
  const [reading, setReading] = useState<VisiblePage | null>(null);

  useEffect(() => {
    const main = document.querySelector('main.main');
    if (!main) return;
    let timer = 0;
    let last = '';
    const scan = () => {
      const next = readVisiblePage(main, pathname);
      const json = JSON.stringify(next);
      if (json === last) return;
      last = json;
      setReading(next);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(scan, 200);
    };
    scan();
    const observer = new MutationObserver(schedule);
    observer.observe(main, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [pathname]);

  usePublishViewContext({
    activity: 'viewing',
    kind: 'page',
    label: reading?.title || route.page,
    domainCode: route.domainCode,
    entityId: route.entityId,
  });
  usePublishPageData(reading?.data ?? { path: pathname, title: route.page });
  // Draws nothing: it only tells the assistant what is on screen.
  return null;
}
